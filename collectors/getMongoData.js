// getMongoData.js — local MongoDB healthcheck snapshot collector for FTDC Analyzer.
//
// Lineage / attribution: this is an "allinfo"-style collector in the spirit of the
// open-source getMongoData.js / Keyhole healthcheck tooling (Apache-2.0). It is an
// adaptation written for FTDC Analyzer — not the verbatim upstream file — gathering the
// build/host/server/replication context plus per-database and per-collection storage and
// INDEX-USAGE statistics that FTDC alone cannot provide (FTDC is host-level only).
//
// Output: a single JSON document to stdout. Run with mongosh:
//
//     mongosh "<connection-uri>" --quiet --file collectors/getMongoData.js > healthcheck.json
//
// Least privilege: the built-in roles `clusterMonitor` + `readAnyDatabase` are sufficient
//     db.getSiblingDB("admin").createRole({ role: "ftdcHealthcheck", privileges: [],
//       roles: ["clusterMonitor", "readAnyDatabase"] })
//
// Privacy: the output is schema-revealing (db/collection/index names, sizes, shard keys).
// Treat it as LOCAL-ONLY — the same as FTDC. For a replica set, run on each member ideally
// (storage stats are per-node). No document contents or query predicates are collected here.

/* global db, print */
(function () {
  function safe(label, fn) {
    try {
      return fn();
    } catch (e) {
      return { _error: String((e && e.message) || e), _section: label };
    }
  }

  const admin = db.getSiblingDB("admin");
  const out = {
    schema: "ftdc-healthcheck/v1",
    collected_at: new Date().toISOString(),
    source: "getMongoData.js (FTDC Analyzer adaptation; getMongoData/Keyhole lineage, Apache-2.0)",
    buildInfo: safe("buildInfo", () => admin.runCommand({ buildInfo: 1 })),
    hostInfo: safe("hostInfo", () => admin.runCommand({ hostInfo: 1 })),
    serverStatus: safe("serverStatus", () =>
      admin.runCommand({ serverStatus: 1, tcmalloc: 0 })
    ),
    getCmdLineOpts: safe("getCmdLineOpts", () => admin.runCommand({ getCmdLineOpts: 1 })),
    replication: safe("replSetGetStatus", () => {
      const rs = admin.runCommand({ replSetGetStatus: 1 });
      // Drop verbose per-op entries; keep member health/optime context.
      if (rs && rs.members) {
        rs.members = rs.members.map((m) => ({
          name: m.name,
          stateStr: m.stateStr,
          health: m.health,
          optimeDate: m.optimeDate,
          lastHeartbeatRecv: m.lastHeartbeatRecv,
          syncSourceHost: m.syncSourceHost,
        }));
      }
      return rs;
    }),
    databases: [],
  };

  const dbList = safe("listDatabases", () => admin.adminCommand({ listDatabases: 1 }));
  const names = (dbList && dbList.databases ? dbList.databases : [])
    .map((d) => d.name)
    .filter((n) => n !== "local" && n !== "config"); // skip internal by default

  names.forEach(function (dbName) {
    const cur = db.getSiblingDB(dbName);
    const dbEntry = {
      name: dbName,
      stats: safe("dbStats:" + dbName, () => cur.runCommand({ dbStats: 1, scale: 1 })),
      collections: [],
    };

    const colls = safe("listCollections:" + dbName, () =>
      cur.getCollectionNames()
    );
    (Array.isArray(colls) ? colls : []).forEach(function (collName) {
      const coll = cur.getCollection(collName);
      const entry = {
        name: collName,
        stats: safe("collStats:" + dbName + "." + collName, () =>
          cur.runCommand({ collStats: collName, scale: 1, indexDetails: false })
        ),
        // Index usage — the key signal for unused/redundant indexes ($indexStats).
        indexes: safe("indexes:" + dbName + "." + collName, () =>
          coll.getIndexes()
        ),
        indexUsage: safe("indexStats:" + dbName + "." + collName, () =>
          coll
            .aggregate([{ $indexStats: {} }])
            .toArray()
            .map((s) => ({
              name: s.name,
              ops: s.accesses ? s.accesses.ops : null,
              since: s.accesses ? s.accesses.since : null,
            }))
        ),
      };
      // Trim the heaviest nested blobs to keep the snapshot legible.
      if (entry.stats && entry.stats.wiredTiger) delete entry.stats.wiredTiger;
      if (entry.stats && entry.stats.indexDetails) delete entry.stats.indexDetails;
      dbEntry.collections.push(entry);
    });

    out.databases.push(dbEntry);
  });

  // Single-line JSON to stdout (redirect to a file).
  print(JSON.stringify(out));
})();

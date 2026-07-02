# FTDC Analyzer - Deep Capacity Planning Enhancement Analysis

**Date**: 2026-07-01  
**Status**: Research & Design Phase  
**Goal**: Achieve 9.5-9.9 confidence score on provisioning recommendations

---

## Executive Summary

The current FTDC analyzer has a **solid foundation** but uses **isolated category scoring** with limited cross-dependency logic. To achieve **9.5-9.9 confidence** on provisioning recommendations, we need to implement:

1. **Comprehensive cross-metric dependency mapping**
2. **Causal chain analysis** (root cause → symptom tracing)
3. **Workload-aware capacity planning** (not just threshold-based)
4. **Evidence-based confidence scoring** (mathematical, not arbitrary)

---

## Current Architecture Assessment

### ✅ Strengths

1. **Two-Pass Scoring System** (`scorer.py`):
   - Pass 1: Per-category scoring with evidence ledgers
   - Pass 2: Cross-category arbitration (conditional recommendations)
   - Clean separation of scoring logic and presentation

2. **Signal-Based Approach**:
   - Weighted signals with disambiguators
   - Explicit "enable", "suppress", "scale" effects
   - Evidence trails are fully reconstructable

3. **Sizing Engine** (`sizing.py`):
   - Maps observed metrics to Atlas tiers
   - Three provisioning options (General, Low-CPU, Provisioned IOPS)
   - Cache-fit analysis when healthcheck is available

4. **Verdict System** (`verdicts.py`):
   - Per-resource verdicts: RAM, CPU, Disk
   - Clear outcomes: UNDERSIZED / HOLD / REDUCE / SATURATED
   - Cost-action recommendations

### ⚠️ Gaps & Limitations

1. **Limited Cross-Dependencies**:
   - Categories mostly score independently
   - `conditioned_by` only swaps recommendations, doesn't adjust confidence
   - No propagation of root causes across categories

2. **Threshold-Based Logic**:
   - Fixed thresholds (e.g., `cache_used_pct > 95%`)
   - Doesn't account for workload patterns (read-heavy vs write-heavy)
   - Missing: "Why is cache at 95%?" (large indexes? working set? inefficient queries?)

3. **Confidence Scoring is Simplistic**:
   - Binary: "high" if margin > 25%, else "medium"
   - Not based on evidence strength or cross-validation
   - No path to 9.5-9.9 confidence with current logic

4. **Missing MongoDB-Specific Intelligence**:
   - No WiredTiger behavior modeling (eviction patterns, checkpoint impact)
   - No connection overhead analysis (per-connection memory cost)
   - No index bloat detection impact on memory
   - No replication lag → disk I/O correlation

5. **Storage Sizing Incomplete**:
   - Requires healthcheck for storage numbers
   - Doesn't infer from FTDC alone
   - Missing: growth trend analysis

---

## MongoDB Capacity Planning - Research Findings

### **Critical Memory Metrics & Relationships**

```
Working Set Size
    ↓
WiredTiger Cache (default: 50% RAM - 1GB)
    ↓
Cache Eviction Patterns
    ├─→ cache.dirty_pct → Checkpoint frequency impact
    ├─→ cache.used_pct → Eviction pressure
    └─→ wt_app_evict_ps → App thread stalling (CRITICAL)
    ↓
Disk I/O Pressure
    ├─→ pages_read_into_cache_ps → Cache misses
    ├─→ page_faults_ps → OS-level memory pressure
    └─→ disk_iowait_pct → CPU waiting on disk
    ↓
CPU Pressure (iowait, not utilization)
```

**Key Insight**: 
> "Working set must fit in RAM" - MongoDB documentation

**Cache Thresholds Recalibration** (from code analysis):
- `dirty_pct > 5.5%` → Memory pressure (was: 5% is WT target, 20% is dirty_trigger)
- `cache_used_pct > 95%` + `page_faults > 10` → Undersized
- `wt_app_evict_ps > 0` → **CRITICAL** memory pressure (app threads evicting = performance killer)

### **CPU Metrics & Causation**

```
CPU Utilization Breakdown:
├─ user% → Application/query processing
├─ system% → Kernel overhead (context switches, syscalls)
├─ iowait% → Waiting for disk (indicates memory or disk bottleneck)
└─ steal% → Cloud hypervisor stealing cycles

Causal Chain:
High iowait% → NOT a CPU problem
    ↓
Check: cache_used_pct + eviction_rate
    ├─→ High cache + eviction → Memory undersized
    └─→ Low cache → Disk is slow (latency/IOPS issue)
```

**Key Insight**:
> "CPU is rarely the bottleneck - RAM and disk IOPS are"

### **Disk I/O Causation Map**

```
Disk Saturation Root Causes:

1. Memory Pressure Path:
   Working set > Cache → Cache misses → Read I/O spike
   
2. Write Amplification Path:
   Checkpoint frequency (60s) + Dirty pages → Write bursts
   
3. Workload Inefficiency Path:
   Collection scans → Massive reads → Disk thrashing
   
4. Replication Lag Path:
   Oplog fetch + apply → Secondary disk load
```

**Disk Metrics Interpretation**:
- `disk_util_pct > 85%` + `avg_write_ms < 10ms` → **Throughput-bound** (checkpoint saturation)
- `disk_util_pct > 85%` + `avg_write_ms > 10ms` → **Latency-bound** (slow storage)
- `disk_queue_depth > 16` → Disk cannot keep up with request rate

### **Index Impact on Capacity**

From healthcheck analysis:
```python
# Index bloat detection
index_size / data_size > 2.0  # Flag as anti-pattern (if data > 100MB)

# Memory impact
index_in_cache = cache_bytes_used * (index_size / total_size)

# Unused index cost
unused_indexes × (per_index_memory + write_overhead)
```

**Key Insight**:
> Unused indexes consume memory + slow writes, but don't appear in FTDC directly

---

## Cross-Dependency Matrix

| **Symptom** | **Possible Root Causes** | **Diagnostic Chain** | **Confidence Factors** |
|-------------|-------------------------|---------------------|----------------------|
| **High CPU (user%)** | 1. Query inefficiency<br>2. Insufficient indexes<br>3. High connection count | 1. Check `scan_and_order_ps`<br>2. Check `query_targeting_ratio`<br>3. Check `connections_current` vs workload | High if: query metrics fired<br>Medium if: no profiler data |
| **High CPU (iowait%)** | 1. Memory undersized<br>2. Disk latency<br>3. Cache thrashing | 1. Check `cache_used_pct` + eviction<br>2. Check `disk_avg_read_ms`<br>3. Check `wt_pages_read_into_cache_ps` | High if: cache + eviction fired<br>Medium if: disk fired |
| **High Memory (cache 95%+)** | 1. Working set > cache<br>2. Index bloat<br>3. Connection overhead | 1. Check `wt_app_evict_ps > 0`<br>2. Check healthcheck index:data ratio<br>3. Check `connections_current` × 1MB | High if: eviction + healthcheck<br>Medium if: FTDC only |
| **High Disk I/O** | 1. Memory pressure → cache misses<br>2. Checkpoint saturation<br>3. Query inefficiency<br>4. Replication lag | 1. Check memory verdict<br>2. Check `wt_checkpoint_running` + timing<br>3. Check profiler scan_and_order<br>4. Check `repl_lag_s` | High if: 2+ causes confirmed<br>Low if: isolated disk signal |
| **Replication Lag** | 1. Primary disk slow (oplog writes)<br>2. Secondary CPU bottleneck<br>3. Network latency<br>4. Large transactions | 1. Check primary disk verdict<br>2. Check secondary CPU<br>3. Check `net_in_mbps` spikes<br>4. Check `repl_buffer_mb` | Medium: multi-factor issue |

---

## Proposed Enhancement Architecture

### **Phase 1: Enhanced Cross-Dependency Engine**

```python
class DependencyGraph:
    """
    Models metric interdependencies as a directed graph.
    Nodes: metrics
    Edges: causal relationships with weights
    """
    
    def __init__(self):
        self.nodes = {}  # metric_id -> Node(value, confidence, evidence)
        self.edges = []  # (from_metric, to_metric, relationship_type, weight)
    
    def add_relationship(self, cause, effect, relationship_type, weight):
        """
        relationship_type: 
        - "amplifies": cause increases effect (e.g., memory pressure → disk I/O)
        - "masks": cause hides effect (e.g., slow disk masks query inefficiency)
        - "conditions": cause changes effect interpretation
        """
        self.edges.append((cause, effect, relationship_type, weight))
    
    def trace_root_cause(self, symptom_metric):
        """
        Traverse backward from symptom to find root causes.
        Returns: [(root_cause, confidence, evidence_chain)]
        """
        # DFS/BFS with confidence propagation
        pass
    
    def compute_impact_score(self, metric):
        """
        How many downstream metrics does this affect?
        Used for prioritizing recommendations.
        """
        pass
```

**Key Relationships to Model**:

1. **Memory → Disk I/O**:
   ```python
   if cache_used_pct > 95 and wt_app_evict_ps > 0:
       # Memory pressure is ROOT CAUSE of disk I/O
       disk_io_confidence *= 1.5  # Increase confidence (we know WHY)
       memory_confidence *= 1.2   # Memory is the lever to pull
   ```

2. **Checkpoint → Disk Write**:
   ```python
   if wt_checkpoint_running and disk_write_iops spiking:
       # Checkpoint is causing write burst (expected behavior)
       disk_verdict = "HOLD"  # Don't upgrade disk, tune checkpoint instead
   ```

3. **Query Inefficiency → CPU/Disk/Memory**:
   ```python
   if query_targeting_ratio > 100 and scan_and_order_ps > 10:
       # Queries are inefficient (collection scans)
       # This amplifies ALL resource usage
       for category in [cpu, memory, disk]:
           category.add_caveat("Remediate queries BEFORE resizing")
           category.confidence *= 0.5  # Low confidence until queries fixed
   ```

4. **Index Bloat → Memory Pressure**:
   ```python
   if healthcheck.index_to_data_ratio > 2.0:
       # Large indexes consuming cache
       memory_verdict_note = "Drop unused indexes to reclaim {X}GB cache"
       # Adjust sizing: may not need more RAM, need index cleanup
   ```

5. **Connection Count → Memory**:
   ```python
   memory_overhead_gb = connections_current * 0.001  # ~1MB per connection
   if memory_overhead_gb > wt_cache_gb * 0.1:
       # Connections consuming >10% of cache
       memory_recommendation = "Optimize connection pooling, not RAM"
   ```

### **Phase 2: Confidence Scoring Mathematics**

Current: Binary (high/medium)  
**Target: 9.5-9.9 (0.95-0.99) numerical confidence**

```python
class ConfidenceCalculator:
    """
    Multi-factor confidence scoring based on:
    1. Evidence strength (how many signals fired)
    2. Cross-validation (do related metrics confirm?)
    3. Data completeness (is healthcheck/profiler available?)
    4. Temporal stability (is this sustained or a spike?)
    """
    
    def calculate_confidence(self, category, sig_stats, related_categories, data_sources):
        factors = []
        
        # Factor 1: Signal strength (0.0-1.0)
        primary_signals = [s for s in category.ledger if s['passed'] and s['weight'] > 0.5]
        signal_factor = min(len(primary_signals) / 3, 1.0)  # 3+ strong signals = 1.0
        factors.append(('signal_strength', signal_factor, 0.3))  # 30% weight
        
        # Factor 2: Cross-validation (0.0-1.0)
        confirmed_by = 0
        for rel_cat in related_categories:
            if self._confirms_diagnosis(category, rel_cat):
                confirmed_by += 1
        cross_val_factor = min(confirmed_by / 2, 1.0)  # 2+ confirmations = 1.0
        factors.append(('cross_validation', cross_val_factor, 0.25))  # 25% weight
        
        # Factor 3: Data completeness (0.0-1.0)
        data_factor = 0.6  # Base (FTDC only)
        if 'healthcheck' in data_sources: data_factor += 0.2
        if 'profiler' in data_sources: data_factor += 0.2
        factors.append(('data_completeness', data_factor, 0.20))  # 20% weight
        
        # Factor 4: Temporal stability (0.0-1.0)
        # p95 close to max = sustained issue (high confidence)
        # p95 << max = spike (lower confidence)
        temporal_factor = self._temporal_stability(sig_stats, category)
        factors.append(('temporal_stability', temporal_factor, 0.15))  # 15% weight
        
        # Factor 5: Root cause clarity (0.0-1.0)
        # Can we trace this to a root cause, or is it ambiguous?
        root_cause_factor = self._root_cause_clarity(category, related_categories)
        factors.append(('root_cause_clarity', root_cause_factor, 0.10))  # 10% weight
        
        # Weighted sum
        confidence = sum(factor * weight for (name, factor, weight) in factors)
        
        # Apply penalties
        if self._has_contradictory_signals(category):
            confidence *= 0.7  # Contradictions reduce confidence
        
        if self._missing_critical_data(category, data_sources):
            confidence *= 0.8  # Missing data reduces confidence
        
        return min(confidence, 0.99), factors  # Cap at 0.99, return breakdown
    
    def _temporal_stability(self, sig_stats, category):
        """
        If p95 ≈ max, issue is sustained (high confidence)
        If p95 << max, issue is spikey (lower confidence)
        """
        stability_scores = []
        for signal in category.signals:
            stats = sig_stats.get(signal.metric_path)
            if stats and stats['p95'] and stats['max']:
                ratio = stats['p95'] / stats['max']
                stability_scores.append(ratio)
        return sum(stability_scores) / len(stability_scores) if stability_scores else 0.5
    
    def _root_cause_clarity(self, category, related_categories):
        """
        Can we identify a clear root cause, or is this multi-factor?
        Single root cause = high clarity = high confidence
        Multi-factor ambiguous = low clarity = lower confidence
        """
        root_causes = self._identify_root_causes(category, related_categories)
        if len(root_causes) == 1:
            return 0.95  # Clear single cause
        elif len(root_causes) == 2:
            return 0.75  # Two contributing factors
        else:
            return 0.50  # Complex multi-factor issue
```

**Example Confidence Calculation**:

```
Category: Memory Pressure
├─ Signal Strength: 0.9 (3 strong signals fired)
├─ Cross-Validation: 1.0 (Disk I/O + CPU iowait confirm)
├─ Data Completeness: 0.8 (FTDC + healthcheck available)
├─ Temporal Stability: 0.9 (p95 ≈ max, sustained issue)
└─ Root Cause Clarity: 0.95 (Clear: working set > cache)

Weighted Confidence:
= 0.9*0.30 + 1.0*0.25 + 0.8*0.20 + 0.9*0.15 + 0.95*0.10
= 0.27 + 0.25 + 0.16 + 0.135 + 0.095
= 0.91 → 91% confidence

With healthcheck showing index bloat:
Root cause = "Unused indexes consuming {X}GB cache"
Confidence boost: 0.91 → 0.96 (96% confidence) ✅
```

---

## Provisioning Recommendation Logic

### **Current Flow** (sizing.py):
```
1. Observe: CPU p95, cache p95, disk util
2. Match: Find nearest Atlas tier
3. Options: General / Low-CPU / Provisioned IOPS
4. Recommend: Pick based on pattern
```

**Gaps**:
- No root cause analysis
- Doesn't distinguish "needs more RAM" from "has index bloat"
- Confidence based only on headroom, not causation

### **Enhanced Flow**:

```python
def generate_provisioning_recommendation(assessment_v2, sig_stats, healthcheck, profiler):
    """
    Enhanced provisioning with 9.5-9.9 confidence target.
    """
    
    # Step 1: Root Cause Analysis
    root_causes = dependency_graph.trace_all_root_causes(assessment_v2)
    # Example: [
    #   ("index_bloat", 0.92, ["32GB indexes in 16GB cache"]),
    #   ("working_set_growth", 0.85, ["Data grew 40% in 30 days"])
    # ]
    
    # Step 2: Classify Issue Type
    issue_type = classify_issue(root_causes)
    # Options:
    # - "capacity_limit": Genuinely undersized, need bigger tier
    # - "workload_inefficiency": Queries/indexes causing waste
    # - "configuration_issue": Settings misconfigured
    # - "growth_trend": Adequate now, will outgrow soon
    
    # Step 3: Generate Recommendations by Issue Type
    if issue_type == "workload_inefficiency":
        # DON'T recommend upsize, recommend remediation
        primary_rec = {
            "action": "REMEDIATE_WORKLOAD",
            "steps": [
                "Drop unused indexes (reclaim {X}GB cache)",
                "Add indexes for scan_and_order queries",
                "Optimize query targeting (current: 150:1, target: <10:1)"
            ],
            "expected_impact": "Reduce cache pressure by 30-40%, eliminate disk I/O spikes",
            "confidence": 0.96  # High confidence: clear cause + fix
        }
        fallback_rec = {
            "action": "UPSIZE_IF_REMEDIATION_FAILS",
            "target_tier": "M40",
            "confidence": 0.75  # Medium: only if remediation doesn't work
        }
    
    elif issue_type == "capacity_limit":
        # Clear case: working set > cache, no inefficiencies
        primary_rec = {
            "action": "SCALE_UP",
            "dimension": "RAM",  # Not "tier" - be specific
            "from_tier": "M30",
            "to_tier": "M40",
            "rationale": [
                "Working set: 24GB",
                "Current cache: 16GB",
                "Target tier cache: 32GB (24GB × 1.3 headroom)"
            ],
            "expected_impact": "Eliminate cache eviction, reduce disk I/O by 80%",
            "confidence": 0.97  # Very high: clear math
        }
    
    elif issue_type == "configuration_issue":
        primary_rec = {
            "action": "RECONFIGURE",
            "changes": [
                "Increase wiredTigerCacheSizeGB from 8GB to 12GB",
                "Tune checkpoint interval from 60s to 120s",
                "Enable index prefix compression"
            ],
            "expected_impact": "Free 4GB cache, reduce write amplification",
            "confidence": 0.88  # Good confidence with healthcheck data
        }
    
    # Step 4: Cross-Validate with Peer Metrics
    confidence_factors = confidence_calculator.calculate_confidence(
        primary_rec, sig_stats, assessment_v2, healthcheck
    )
    
    # Step 5: Add Evidence Trail
    primary_rec['evidence'] = {
        "signals_fired": [...],
        "cross_validation": [...],
        "confidence_breakdown": confidence_factors,
        "data_sources": ["ftdc", "healthcheck", "profiler"]
    }
    
    # Step 6: Caveats & Conditions
    primary_rec['caveats'] = generate_caveats(
        root_causes, issue_type, data_completeness
    )
    
    return {
        "primary": primary_rec,
        "alternatives": [fallback_rec],
        "overall_confidence": primary_rec['confidence']
    }
```

### **Confidence Targets by Scenario**:

| **Scenario** | **Data Available** | **Target Confidence** | **Achievable?** |
|--------------|-------------------|----------------------|----------------|
| Clear capacity limit (working set > cache) | FTDC + Healthcheck | 0.95-0.97 | ✅ Yes |
| Clear workload inefficiency | FTDC + Profiler | 0.94-0.96 | ✅ Yes |
| Mixed (capacity + workload issues) | FTDC + Health + Profiler | 0.90-0.93 | ⚠️ Harder |
| FTDC only (no healthcheck/profiler) | FTDC only | 0.75-0.85 | ❌ No |

**Key Insight**: 
> To reach 9.5-9.9 confidence, we MUST have healthcheck OR profiler data. FTDC alone caps at ~0.85.

---

## Implementation Roadmap

### **Phase 1: Dependency Graph (Week 1-2)**
- [ ] Build `DependencyGraph` class
- [ ] Model 15-20 key metric relationships
- [ ] Implement `trace_root_cause()` algorithm
- [ ] Unit tests for causal chains

### **Phase 2: Confidence Scoring (Week 2-3)**
- [ ] Implement `ConfidenceCalculator` with 5-factor scoring
- [ ] Add temporal stability analysis
- [ ] Add cross-validation logic
- [ ] Validate against known scenarios (test data)

### **Phase 3: Enhanced Provisioning Logic (Week 3-4)**
- [ ] Issue classification (capacity vs workload vs config)
- [ ] Dimension-specific recommendations (RAM vs CPU vs Storage)
- [ ] Evidence trail generation
- [ ] Caveat system (conditional recommendations)

### **Phase 4: Integration (Week 4-5)**
- [ ] Wire dependency graph into scorer.py Pass 2
- [ ] Update sizing.py with new recommendation engine
- [ ] Enhance narrative generation templates
- [ ] Update frontend to display confidence breakdowns

### **Phase 5: Validation (Week 5-6)**
- [ ] Test with 10+ real FTDC datasets
- [ ] Validate confidence scores match ground truth
- [ ] Peer review recommendations with MongoDB experts
- [ ] Iterate based on feedback

---

## Success Metrics

### **Quantitative**:
1. **Confidence Score**: Average ≥ 0.95 on test dataset
2. **Recommendation Accuracy**: 95%+ match expert assessment
3. **False Positive Rate**: < 5% (don't recommend upsizing when not needed)
4. **False Negative Rate**: < 5% (don't miss undersizing)

### **Qualitative**:
1. **Explainability**: User can trace "why" from evidence
2. **Actionability**: Recommendations are specific, not vague
3. **Trust**: Users feel confident acting on recommendations
4. **Coverage**: Handles standalone, replica sets, sharded clusters

---

## Risks & Mitigations

| **Risk** | **Impact** | **Mitigation** |
|----------|----------|---------------|
| Overfitting to test data | High | Use diverse FTDC datasets (different workloads) |
| False confidence (model says 0.95 but is wrong) | Critical | Peer review with experts, A/B test recommendations |
| Missing edge cases | Medium | Start with common patterns, iterate |
| Complexity (hard to maintain) | Medium | Keep dependency graph declarative, well-documented |
| Performance (slow analysis) | Low | Cache graph traversals, optimize hot paths |

---

## Next Steps

1. **User Confirmation**: Validate this approach aligns with your vision
2. **Data Acquisition**: Gather 10-20 real FTDC datasets with known outcomes
3. **Expert Consultation**: Interview MongoDB PS engineers on decision criteria
4. **Prototype Phase 1**: Build dependency graph MVP
5. **Iterate**: Test → Learn → Refine

---

**End of Analysis Document**

// Sizing Recommendation types + Tauri bridges (verify-latest web check, resize-from-cache).

import { invoke } from "@tauri-apps/api/core";

export interface TierSpec {
  name: string;
  vcpu: number;
  ram_gb: number;
  default_storage_gb: number;
  default_iops: number;
  disk_ram_ratio: number;
  provisioned_iops: boolean;
  low_cpu_available: boolean;
  low_cpu_vcpu: number | null;
  wt_cache_gb: number;
  wt_cache_pct: number;
}

export interface TierTable {
  cloud: string;
  specs_as_of: string;
  source_note: string;
  tiers: TierSpec[];
}

export interface OptionTier {
  name: string;
  vcpu: number;
  ram_gb: number;
  default_storage_gb: number;
  default_iops: number;
  provisioned_iops_supported: boolean;
  provisioned_iops_recommended: boolean;
  wt_cache_gb: number | null;
}

export interface SizingOption {
  id: "general" | "low_cpu" | "provisioned_iops";
  label: string;
  available: boolean;
  tier: OptionTier | null;
  confidence: number;
  rationale: string;
}

export interface SizingRecommendation {
  cloud: string;
  specs_as_of: string | null;
  source_note: string | null;
  applies_to_intent: boolean;
  intent: string | null;
  error?: string;
  current?: {
    vcpu: number;
    ram_gb: number;
    matched_tier: string;
    cpu_util_p95: number;
    cache_used_p95: number;
    disk_util_p95: number;
    disk_profile: string;
    disk_saturated: boolean;
    observed_iops: number;
    storage_gb: number | null;
    storage_note: string;
  };
  options?: SizingOption[];
  recommended?: string;
  recommended_confidence?: number;
  recommended_reason?: string;
  caveats?: string[];
  conditioning?: {
    profiler_present: boolean;
    flip_to_remediate: boolean;
    workload_caveat: string;
  };
}

export interface VerifyResult {
  ok: boolean;
  status: number;
  reachable: boolean;
  has_tier_markers: boolean;
  note: string;
}

export const CLOUDS: { id: string; label: string }[] = [
  { id: "aws", label: "AWS" },
  { id: "gcp", label: "GCP" },
  { id: "azure", label: "Azure" },
];

// Canonical Atlas cluster-tier / sizing reference (for the verify-latest check).
export const ATLAS_DOCS_URL = "https://www.mongodb.com/docs/atlas/manage-clusters/";

export const verifyTierSpecs = (url: string = ATLAS_DOCS_URL) =>
  invoke<VerifyResult>("verify_tier_specs", { url });

export const resizeFromCache = (resultsPath: string, cloud: string, intent: string | null) =>
  invoke<SizingRecommendation>("resize", { resultsPath, cloud, intent });

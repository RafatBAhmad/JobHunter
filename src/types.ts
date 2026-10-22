export type Job = {
  /** Stable id, prefixed with the source name, used for de-duplication. */
  id: string;
  source: string;
  title: string;
  company: string;
  url: string;
  location: string;
  /** Plain-text description, already stripped of HTML and trimmed. */
  description: string;
  tags: string[];
  salary?: string;
  postedAt?: string;
};

export type Scored = Job & {
  score: number;
  eligible: "yes" | "no" | "unclear";
  eligibility_reason: string;
  fit_reasons: string;
  red_flags: string;
  pitch: string;
};

export type Profile = typeof import("../profile.json");

import { config } from "../config.js";
import { invalid } from "./errors.js";

const L = config.limits;

/**
 * Usernames in a 2006 handle style: letters, digits, spaces, dots, dashes and
 * underscores ("W. Hale", "dan_b"), starting with a letter or digit, no
 * doubled spaces. No quotes or brackets, so a name always fits in a
 * [quote="…"] attribute.
 */
export function validateUsername(raw: string): string {
  const name = raw.trim();
  if (name.length < L.username_min || name.length > L.username_max) {
    throw invalid(`Usernames are ${L.username_min}–${L.username_max} characters.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) || name.includes("  ")) {
    throw invalid(
      "Usernames use letters, digits, spaces, dots, dashes and underscores, and start with a letter or digit."
    );
  }
  return name;
}

export function validatePassword(password: string): string {
  if (password.length < L.password_min) {
    throw invalid(`Passwords need at least ${L.password_min} characters.`);
  }
  if (password.length > 1024) throw invalid("That password is too long.");
  return password;
}

export function validateThreadTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") throw invalid("The thread needs a title.");
  if (title.length > L.thread_title_max) {
    throw invalid(`Titles are at most ${L.thread_title_max} characters.`);
  }
  return title;
}

export function validatePostBody(raw: string): string {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body === "") throw invalid("The post is empty.");
  if (body.length > L.post_body_max) {
    throw invalid(`Posts are at most ${L.post_body_max.toLocaleString("en-US")} characters.`);
  }
  return body;
}

/** An empty title clears it, falling back to the rank title. */
export function validateUserTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") return null;
  if (title.length > L.title_max) throw invalid(`Titles are at most ${L.title_max} characters.`);
  return title;
}

export function validateBio(raw: string): string {
  const bio = raw.replace(/\r\n?/g, "\n").trim();
  if (bio.length > L.bio_max) throw invalid(`Bios are at most ${L.bio_max} characters.`);
  return bio;
}

/** PM subjects are optional; an empty one reads as "(no subject)". */
export function validatePmSubject(raw: string): string {
  const subject = raw.replace(/\s+/g, " ").trim();
  if (subject === "") return "(no subject)";
  if (subject.length > L.thread_title_max) {
    throw invalid(`Subjects are at most ${L.thread_title_max} characters.`);
  }
  return subject;
}

export function validateReason(raw: string, what = "a reason"): string {
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason === "") throw invalid(`Give ${what}.`);
  if (reason.length > L.reason_max) throw invalid(`Keep it under ${L.reason_max} characters.`);
  return reason;
}

/** Optional reasons (lock, sticky…) may be blank. */
export function optionalReason(raw: string): string {
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length > L.reason_max) throw invalid(`Keep it under ${L.reason_max} characters.`);
  return reason;
}

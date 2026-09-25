import assert from "node:assert/strict";
import { LoginLimiter } from "../src/auth/login-limiter.js";
import { parsePublicUrl } from "../src/config.js";
import { ForumError } from "../src/forum/errors.js";
import { validateUsername, validateUserTitle } from "../src/forum/validate.js";
import { AVATAR_COLORS, avatarColor, avatarInitial } from "../src/lib/avatar.js";
import { pageOf, paginate } from "../src/lib/pagination.js";
import { safeNext } from "../src/routes/util.js";
import { pageWindow } from "../src/views/components.js";

function testUsernames() {
  for (const ok of ["Dan", "W. Hale", "dan_b", "Lamplighter", "x2", "J.R.R."]) {
    assert.equal(validateUsername(` ${ok} `), ok);
  }
  for (const bad of ["a", "", " ", ".dan", "dan  b", 'say "hi"', "[b]x", "x".repeat(25), "émile"]) {
    assert.throws(() => validateUsername(bad), ForumError, bad);
  }
}

function testUserTitles() {
  assert.equal(validateUserTitle("   "), null);
  assert.equal(validateUserTitle("  Rereading   Montaigne, slowly "), "Rereading Montaigne, slowly");
  assert.throws(() => validateUserTitle("x".repeat(41)), ForumError);
}

function testPagination() {
  assert.deepEqual(paginate(undefined, 0, 25), { page: 1, pageCount: 1, offset: 0, perPage: 25 });
  assert.equal(paginate("3", 51, 25).page, 3);
  assert.equal(paginate("4", 51, 25).page, 3);
  assert.equal(paginate("-2", 51, 25).page, 1);
  assert.equal(paginate("junk", 51, 25).page, 1);
  assert.equal(paginate("2", 51, 25).offset, 25);
  assert.equal(pageOf(25, 25), 1);
  assert.equal(pageOf(26, 25), 2);
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(6, 12), [1, null, 4, 5, 6, 7, 8, null, 12]);
  assert.deepEqual(pageWindow(2, 5), [1, 2, 3, 4, 5]);
}

function testAvatars() {
  assert.equal(avatarColor("Dan"), avatarColor("dan"), "case doesn't change a member's color");
  assert.ok(avatarColor("W. Hale") >= 0 && avatarColor("W. Hale") < AVATAR_COLORS);
  const spread = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(avatarColor));
  assert.ok(spread.size >= 5, "colors spread across the palette");
  assert.equal(avatarInitial("W. Hale"), "W");
  assert.equal(avatarInitial("_dan"), "D");
}

function testLoginLimiter() {
  let now = 0;
  const limiter = new LoginLimiter(2, 1000, () => now);
  limiter.recordFailure("Dan");
  assert.equal(limiter.isBlocked("dan"), false);
  limiter.recordFailure("dan");
  assert.equal(limiter.isBlocked("DAN"), true);
  now = 1000;
  assert.equal(limiter.isBlocked("dan"), false, "the window expires");
  limiter.recordFailure("dan");
  limiter.recordSuccess("dan");
  assert.equal(limiter.isBlocked("dan"), false);
}

function testSafeNext() {
  assert.equal(safeNext("/t/1?page=2"), "/t/1?page=2");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("/\\evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext(undefined), "/");
}

function testPublicUrl() {
  assert.deepEqual(parsePublicUrl("https://board.fritter.lol", 3100), {
    origin: "https://board.fritter.lol",
    basePath: "",
    secureCookies: true,
    port: 3100,
  });
  const sub = parsePublicUrl("https://fritter.lol/board/", 3100);
  assert.equal(sub.origin, "https://fritter.lol");
  assert.equal(sub.basePath, "/board");
  assert.equal(parsePublicUrl("http://localhost:3100", 3100).secureCookies, false);
}

testUsernames();
testUserTitles();
testPagination();
testAvatars();
testLoginLimiter();
testSafeNext();
testPublicUrl();
console.log("helpers: all tests passed");

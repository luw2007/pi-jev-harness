import assert from "node:assert/strict";
import { test } from "node:test";
import { containsCredential } from "../../../../src/adapters/pi/config.ts";
import { CREDENTIAL_REDACTED, scrubCredentials } from "../../../../src/adapters/pi/harness.ts";

// Credential-shaped samples are assembled at runtime so no literal secret sits in the source.
const j = (...parts: string[]) => parts.join("");

const HITS: Array<[string, string]> = [
  ["JSON token", j('{"to', 'ken": "', "a1B2c3D4e5F6g7H8", '"}')],
  ["JSON access_token", j('{"access_', 'token":"', "Zx9Yw8Vu7Ts6", '"}')],
  ["YAML password", j("pass", "word: ", "Hunter2025!x")],
  ["YAML api_key quoted", j("api_", "key: '", "k3y-v4lu3-9988", "'")],
  ["colon secret", j("sec", "ret:", "s3cr3tValue77")],
  ["Authorization Bearer", j("Authorization: ", "Bearer ", "abc123DEF456ghi789")],
  ["JWT", j("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "SflKxwRJSMeKKF2QT4fw")],
  ["Google AIza", j("AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")],
  ["GitLab glpat-", j("gl", "pat-", "xY12zW34vU56tS78rQ90")],
  ["Slack xoxb-", j("xo", "xb-", "1234567890-abcdefghij")],
  ["Slack xoxp-", j("xo", "xp-", "0987654321-klmnopqrst")],
  ["GitHub github_pat_", j("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnop")],
  // H2: a letters-only value is a secret once it is long enough.
  ["JSON apiKey letters only", j('{"api', 'Key": "', "abcdefghijklmnopqrstuvwx", '"}')],
  ["YAML token letters only", j("to", "ken: ", "QwErTyUiOpAsDfGhJk")],
  // M5: prefixes in any case.
  ["upper SK-", j("token is ", "SK", "-ABCDEFGH12345678")],
  ["upper GHP_", j("GH", "P_", "abcdefgh12345678")],
  ["upper XOXB-", j("XO", "XB-", "1234567890-abcdefghij")],
  ["upper GLPAT-", j("GL", "PAT-", "xY12zW34vU56tS78rQ90")],
  ["lower akia", j("ak", "ia", "ABCDEFGHIJKLMNOP")],
  // defect 2: glued to a JSON-escaped newline or after an underscore.
  ["JSON-escaped newline sk-", JSON.stringify({ m: j("Incorrect API key provided:\n", "sk-", "proj-ABCDEFGH12345678abcdefgh") })],
  ["JSON-escaped tab ghp_", j("x\\t", "ghp_", "abcdefgh12345678")],
  ["underscore-glued DB_PASSWORD", j("DB_PASS", "WORD=", "hunter2")],
  ["JSON-escaped quoted assignment", j('token=\\"', "abcdefghijklmnopqrstuvwx", '\\"')],
];

const PASSES = [
  "password reset flow",
  "token budget is 20",
  "the api key rotation doc",
  "Explain the password: reset handling",
  "token: budget",
  "Authorization: Bearer",
  // Short bare words after a credential keyword are not secrets.
  '{"token": true}',
  '{"password": null, "secret": "none"}',
  "apiKey: undefined",
  "token: placeholder",
  "password: required",
  // A prefix glued to a word is part of that word, not a key.
  "run the risk-assessment-framework task",
  "the task-management-module and desk-reservations",
  "max_tokens: 4096",
];

for (const [name, text] of HITS) {
  test(`credential pattern hit: ${name}`, () => {
    assert.equal(containsCredential(text, undefined), true);
  });
}

for (const text of PASSES) {
  test(`plain English passes: ${text}`, () => {
    assert.equal(containsCredential(text, undefined), false);
  });
}

const PEM_BODY = j("MIIEowIBAAKCAQEA", "7bq9XyZ0p1Qw2Er3Ty4Ui5Op6As7Df8Gh9Jk");

// H3/H4/defect 2: scrubbing removes the whole secret value, not only its keyword or banner.
const SCRUBS: Array<[string, string, string]> = [
  ["H3 keyword = quoted letters-only value", j('upstream rejected: api', 'Key = "', "abcdefghijklmnopqrstuvwx", '" invalid'), "abcdefghijklmnopqrstuvwx"],
  ["H3 keyword = unquoted value", j("pass", "word=", "hunter2hunter2", " next"), "hunter2"],
  ["H2 JSON letters-only value", j('{"api', 'Key": "', "abcdefghijklmnopqrstuvwx", '"}'), "abcdefghijklmnopqrstuvwx"],
  ["H4 PEM body through END", j("key:\n-----BEGIN RSA PRIVATE ", "KEY-----\n", PEM_BODY, "\n-----END RSA PRIVATE KEY-----\ntrailer"), PEM_BODY],
  ["H4 truncated PEM body", j("-----BEGIN PRIVATE ", "KEY-----\n", PEM_BODY), PEM_BODY],
  ["defect 2 JSON-escaped sk-", `401 ${JSON.stringify({ error: { message: j("Incorrect API key provided:\n", "sk-", "proj-ABCDEFGH12345678abcdefgh") } })}`, "ABCDEFGH"],
];

for (const [name, text, secret] of SCRUBS) {
  test(`scrub removes the whole secret: ${name}`, () => {
    const out = scrubCredentials(text, undefined);
    assert.ok(!out.includes(secret), `leaked: ${out}`);
    assert.equal(containsCredential(out, undefined), false);
  });
}

test("scrub keeps text around the secret", () => {
  const out = scrubCredentials(j("before ", "pass", "word=", "hunter2hunter2", " after"), undefined);
  assert.equal(out, `before ${CREDENTIAL_REDACTED} after`);
});

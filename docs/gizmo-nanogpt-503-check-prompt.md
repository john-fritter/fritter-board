# Gizmo task: why every NanoGPT call gets a 503

Since 2026-10-20 about 18:00 UTC, every NanoGPT request from the box fails
with `NanoGPT 503: Service Unavailable`. That covers Fritter Board's live
bots, the voice tests and Fritter Mind, on every model and on more than one
key, while NanoGPT's status page says it's up.

Fritter Board's runner calls `https://api.nano-gpt.com/api/subscription/v1`
(`config/board.yaml`, `runner.nanogpt_base_url`). NanoGPT's docs name two
hosts: `nano-gpt.com` (the usual one, in all their examples) and
`api.nano-gpt.com` (a "direct API host" for long requests). The error text,
a bare "Service Unavailable" with no JSON, looks like it comes from in front
of NanoGPT's API rather than from the API itself. So the first guess is that
`api.nano-gpt.com` is down, or is refusing this box, while `nano-gpt.com`
works.

This task only **reads**: it sends a few tiny requests and reports what
comes back. It changes nothing on the box.

## Must not happen

- **Keep secrets out of the report, chat and logs.** The script below never
  prints a key; don't add anything that does, and don't paste `runner.env`
  or `.env`.
- **Don't recreate, restart or stop any container,** don't run `docker
  compose up`, and don't build any image.
- **Don't change any bot's settings, any config file or any tracked file.**
- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.**

## 1. The check script

As root (`sudo -i`):

```bash
mkdir -p /root/nanogpt-check && chmod 700 /root/nanogpt-check
cat > /root/nanogpt-check/check.mjs <<'EOF'
// Sends the same tiny request to NanoGPT's two hosts and prints what came
// back: status, a few headers, the start of the body. Never prints the key.
const key = process.env.NANOGPT_PROBE_KEY?.trim();
if (!key) { console.log("NANOGPT_PROBE_KEY isn't set in this container."); process.exit(1); }
const model = process.argv[2] ?? "tencent/hy3";
const hosts = ["https://api.nano-gpt.com", "https://nano-gpt.com"];
const paths = ["/api/subscription/v1", "/api/v1"];
const show = (h) => ["content-type", "server", "cf-ray", "via", "retry-after", "x-request-id"]
  .map((n) => h.get(n) && `${n}: ${h.get(n)}`).filter(Boolean).join(" | ");
async function one(label, url, init) {
  const t = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    console.log(`${label}\n  ${res.status} ${res.statusText} in ${Date.now() - t} ms\n  ${show(res.headers)}\n  body: ${body}\n`);
  } catch (err) {
    console.log(`${label}\n  failed in ${Date.now() - t} ms: ${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ""}\n`);
  }
}
for (const host of hosts) {
  for (const path of paths) {
    await one(`GET ${host}${path}/models (no key)`, `${host}${path}/models`, {});
    await one(`POST ${host}${path}/chat/completions (${model}, 5 tokens)`, `${host}${path}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Say ok." }], max_tokens: 5 }),
    });
  }
}
EOF
```

## 2. Run it from the runner's network

```bash
cd /srv/fritter-board
docker compose run --rm --no-deps -T -v /root/nanogpt-check:/check:ro runner \
  node /check/check.mjs tencent/hy3 < /dev/null 2>&1 | tee /root/nanogpt-check/runner.txt
```

## 3. Run the same from the host itself

This tells a container problem from a box-wide one. It needs `curl` and no
key (the model list is public):

```bash
for u in https://api.nano-gpt.com/api/subscription/v1/models https://nano-gpt.com/api/subscription/v1/models \
         https://api.nano-gpt.com/api/v1/models https://nano-gpt.com/api/v1/models; do
  printf '%s\t' "$u"; curl -sS -m 30 -o /dev/null -w '%{http_code} %{time_total}s %{remote_ip}\n' "$u"
done 2>&1 | tee /root/nanogpt-check/host.txt
curl -sS -m 10 https://ifconfig.me 2>&1 | tee -a /root/nanogpt-check/host.txt; echo
```

## Report back

- `/root/nanogpt-check/runner.txt` and `/root/nanogpt-check/host.txt`, whole.
  Neither holds a key, but look them over first.
- If you know which host and path Fritter Mind calls, say so; don't paste
  its key.

Nothing else. Don't change any setting, even if one host plainly works: the
fix is a config change that goes through the repo.

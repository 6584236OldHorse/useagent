// Drive one run on the certification plane and watch it settle; then exercise
// the terminal (with a resize and a server started inside for the port check).
//
//   bun run run.ts <engine> [model] [prompt]
//   bun run run.ts show <runId>
//   bun run run.ts terminal <runId>    (then GET /api/port-proxy/<runId>/8765/)

const PLANE = process.env.PLANE ?? "http://127.0.0.1:3402";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${PLANE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface Run {
  id: string;
  status: string;
  engine: string;
  thread_id?: string;
  sandbox_id?: string | null;
  summary?: string | null;
  duration_ms?: number | null;
}

function brief(run: Run) {
  return { id: run.id, status: run.status, engine: run.engine, sandboxId: run.sandbox_id ?? null, summary: (run.summary ?? "").slice(0, 300), durationMs: run.duration_ms ?? null };
}

async function waitSettled(runId: string, timeoutMs: number): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const run = await api<Run>(`/api/runs/${runId}`);
    const line = `${run.status} sandbox=${run.sandbox_id ?? "-"}`;
    if (line !== last) {
      console.log(`[${new Date().toISOString()}] ${line}`);
      last = line;
    }
    if (!["queued", "running", "pending", "accepted"].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs} ms`);
    await Bun.sleep(2000);
  }
}

async function terminal(runId: string): Promise<void> {
  const socket = new WebSocket(`${PLANE.replace(/^http/, "ws")}/api/runs/${runId}/terminal?cols=100&rows=30`, { headers: { origin: "http://localhost:3400" } } as unknown as string[]);
  const output: string[] = [];
  socket.onmessage = (event) => output.push(String(event.data));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("terminal socket failed"));
  });
  const type = async (data: string, waitMs: number) => {
    socket.send(JSON.stringify({ type: "input", data }));
    await Bun.sleep(waitMs);
  };
  await Bun.sleep(2500);
  await type("echo TERMINAL_$(id -u)_OK; uname -m\n", 1500);
  socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await Bun.sleep(2000);
  await type("stty size\n", 1500);
  await type("nohup bun -e \"Bun.serve({port:8765,fetch(){return new Response('PORT_OK from '+require('os').hostname())}})\" >/tmp/srv.log 2>&1 &\n", 2500);
  await type("curl -s http://127.0.0.1:8765/ ; echo\n", 2000);
  socket.close();
  const text = output.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
  console.log(text);
  console.log("terminal ok:", text.includes("TERMINAL_1000_OK"), "resized:", /40 120/.test(text), "server inside:", text.includes("PORT_OK"));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "show":
    console.log(JSON.stringify(brief(await api<Run>(`/api/runs/${rest[0]}`)), null, 1));
    break;
  case "terminal":
    await terminal(rest[0]!);
    break;
  default: {
    const engine = command ?? "opencode";
    const model = rest[0] || undefined;
    const prompt = rest[1] || "Create a file named hello.txt containing the word hello. Then run `uname -a` and `cat hello.txt` and report both outputs verbatim.";
    const created = await api<Run>("/api/runs", { method: "POST", body: JSON.stringify({ prompt, engine, ...(model ? { model } : {}) }) });
    console.log("created", JSON.stringify(brief(created)));
    console.log("settled", JSON.stringify(brief(await waitSettled(created.id, Number(process.env.RUN_TIMEOUT_MS ?? 900_000))), null, 1));
  }
}

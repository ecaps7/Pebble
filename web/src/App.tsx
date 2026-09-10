import { type CSSProperties, useEffect, useState } from "react";

type Health = {
  status: string;
  data_dir: string;
  schema_version: number;
  journal_mode: string;
};

type Probe =
  | { state: "checking" }
  | { state: "connected"; health: Health }
  | { state: "failed"; reason: string };

const panel: CSSProperties = {
  borderRadius: 8,
  border: "1px solid #d8d8d8",
  padding: "1rem",
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "0.4rem 1rem",
  margin: 0,
};

export default function App() {
  const [probe, setProbe] = useState<Probe>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Health;
      })
      .then((health) => setProbe({ state: "connected", health }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProbe({
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <main
      style={{
        margin: "0 auto",
        maxWidth: "32rem",
        padding: "2rem 1.25rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>Pebble</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        骨架连通性检查：页面 → FastAPI → SQLite。
      </p>

      <section style={panel}>
        {probe.state === "checking" && <p style={{ margin: 0 }}>正在检查后端连接…</p>}

        {probe.state === "failed" && (
          <p style={{ margin: 0, color: "#b00020" }}>
            后端不可达：{probe.reason}
            <br />
            <span style={{ color: "#555", fontSize: "0.875rem" }}>
              确认后端已启动，且 Vite 代理目标与后端端口一致。
            </span>
          </p>
        )}

        {probe.state === "connected" && (
          <dl style={grid}>
            <dt>状态</dt>
            <dd style={{ margin: 0 }}>{probe.health.status}</dd>
            <dt>实例数据目录</dt>
            <dd style={{ margin: 0, wordBreak: "break-all" }}>{probe.health.data_dir}</dd>
            <dt>schema 版本</dt>
            <dd style={{ margin: 0 }}>{probe.health.schema_version}</dd>
            <dt>journal mode</dt>
            <dd style={{ margin: 0 }}>{probe.health.journal_mode}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}

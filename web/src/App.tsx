// Layout only. The top of the page tells the story in plain words; the
// engineering evidence lives under "Under the hood". Every value on screen
// comes from useRun (live stream state) or metrics.ts (numbers derived from the
// events that actually arrived).

import { useMemo, useState } from "react";
import "./App.css";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Architecture, ConnectionRecovery, RunInfo, StreamIntegrity } from "./components/Diagnostics";
import { EventStream } from "./components/EventStream";
import { NowBanner, ProofStrip, StepGuide } from "./components/Guide";
import { streamMetrics } from "./metrics";
import { useRun } from "./useRun";

// One browser session is one conversation, kept across reloads.
const conversationId = (() => {
  const key = "conversationId";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const fresh = `conv_${crypto.randomUUID()}`;
  localStorage.setItem(key, fresh);
  return fresh;
})();

/** Chunks to generate before the injected failure, for the demo checkbox. */
const failAfterChunks = 12;

export default function App() {
  const { view, send, dropConnection, reconnect } = useRun(conversationId);
  const [draft, setDraft] = useState("Explain how resumable streaming works in simple terms.");
  const [failMidway, setFailMidway] = useState(false);

  const metrics = useMemo(
    () => streamMetrics(view.log, view.cursor, view.duplicatesSuppressed),
    [view.cursor, view.duplicatesSuppressed, view.log],
  );

  return (
    <div className="app">
      <AppHeader />

      <StepGuide view={view} />

      <Composer
        view={view}
        draft={draft}
        onDraftChange={setDraft}
        failMidway={failMidway}
        onFailMidwayChange={setFailMidway}
        onSend={() => void send(draft.trim(), failMidway ? failAfterChunks : 0)}
        onDrop={dropConnection}
        onReconnect={reconnect}
      />

      <NowBanner view={view} />
      <Conversation view={view} />
      {view.log.length > 0 && <ProofStrip metrics={metrics} />}

      <details className="hood">
        <summary>
          <span className="hood-title">Under the hood</span>
          <span className="hood-hint">
            Run details, integrity, recovery, event log and architecture &mdash; for engineers
          </span>
        </summary>

        <div className="hood-body">
          <div className="hood-grid">
            <div className="column">
              <RunInfo view={view} />
              <StreamIntegrity metrics={metrics} />
              <ConnectionRecovery view={view} />
            </div>
            <div className="column">
              <EventStream log={view.log} disconnects={view.disconnects} />
            </div>
          </div>
          <Architecture />
        </div>
      </details>

      <footer className="app-footer">
        <p>
          <strong>Relay</strong> · Resumable Conversation Demo · Built for unreliable networks
        </p>
        <p className="muted">One message at a time · No gaps. No duplicates.</p>
      </footer>
    </div>
  );
}

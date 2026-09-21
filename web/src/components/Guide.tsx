// The parts of the page that explain what is going on in plain words:
// a three-step guide, a live sentence about the current state, and four
// numbers that prove nothing was lost.

import type { StreamMetrics } from "../metrics";
import { activeStep, narrate } from "../narration";
import type { RunView } from "../useRun";

const steps = [
  { title: "Press Send", body: "An answer starts arriving, word by word." },
  { title: "Drop connection", body: "While it is still writing. The server keeps generating." },
  { title: "Reconnect", body: "You receive the events you missed, then the live stream continues." },
];

export function StepGuide({ view }: { view: RunView }) {
  const active = activeStep(view);

  return (
    <ol className="steps" aria-label="How to try it">
      {steps.map((step, index) => {
        const number = index + 1;
        const state = active === 4 || number < active ? "done" : number === active ? "current" : "todo";
        return (
          <li
            key={step.title}
            className={`step ${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="step-num" aria-hidden="true">
              {state === "done" ? "✓" : number}
            </span>
            <div>
              <p className="step-title">
                {step.title}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </p>
              <p className="step-body">{step.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const toneIcon = { neutral: "i", good: "✓", warn: "…", bad: "!" } as const;

/** One sentence about right now. Wording is derived from live state. */
export function NowBanner({ view }: { view: RunView }) {
  const now = narrate(view);
  return (
    <section className={`now tone-${now.tone}`} role="status" aria-live="polite">
      <span className="now-icon" aria-hidden="true">
        {toneIcon[now.tone]}
      </span>
      <div>
        <p className="now-title">{now.title}</p>
        <p className="now-detail">{now.detail}</p>
      </div>
    </section>
  );
}

/** The proof, in words a non-engineer can check. */
export function ProofStrip({ metrics }: { metrics: StreamMetrics }) {
  const missing = metrics.missing.length;

  const items = [
    { label: "Events received", value: String(metrics.received), bad: false },
    { label: "Missing events", value: String(missing), bad: missing > 0 },
    { label: "Duplicate events", value: String(metrics.duplicates), bad: false },
    {
      label: "Sequence",
      value: metrics.orderingValid ? "valid" : "invalid",
      bad: !metrics.orderingValid,
    },
  ];

  return (
    <dl className="proof" aria-label="Stream integrity summary">
      {items.map((item) => (
        <div key={item.label} className={item.bad ? "proof-item bad" : "proof-item"}>
          <dt>{item.label}</dt>
          <dd className="mono">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

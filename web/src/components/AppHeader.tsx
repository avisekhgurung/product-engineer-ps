// Product header: identity, one plain sentence about what this page shows, and
// an honest label saying it is a demo.

export function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M13.2 2 4 13.2h5.6L8.9 22 19 10.3h-5.9z" />
          </svg>
        </span>
        <div>
          <p className="brand-name">Relay</p>
          <p className="brand-tagline">Realtime streams that don&rsquo;t lose their place.</p>
        </div>
      </div>

      <div className="header-main">
        <h1>Resumable Conversation</h1>
        <p className="header-lede">
          An answer arrives word by word. Drop the connection in the middle, reconnect, and
          it carries on from exactly where it stopped &mdash; nothing missing, nothing
          repeated.
        </p>
      </div>

      <span className="demo-chip">Engineering Demo</span>
    </header>
  );
}

# Privacy

ShiftFair is a static web page. It has no backend, accounts, analytics,
telemetry, advertising, cookies set by the app, or third-party scripts, fonts
or CDNs.

- **Where your data lives.** Everything you enter (event, roles, volunteers,
  availability, shifts and assignments) is kept in your browser's
  `localStorage` under the key `shiftfair:plan:v1` when browser storage is
  available, and in any JSON/CSV files you choose to export. If storage fails,
  the app reports it and keeps the current session in memory; export JSON for
  a portable backup. The app never uploads roster data anywhere.
- **Network.** The production build ships a Content-Security-Policy with
  `connect-src 'none'`, so the page cannot make network requests for data.
  The browser still downloads the page's own files from the host.
- **Hosting.** If you use a hosted copy (for example on GitHub Pages), the host
  may record standard request data such as your IP address, user agent and
  requested URLs for security and operations, under the host's own privacy
  policy. ShiftFair itself receives none of this.
- **Clearing data.** Use **Clear saved data** → **Confirm clear** in the app,
  or clear this site's storage in your browser settings. Exported files are
  ordinary files on your device; delete them like any other file.
- **Sample data.** The built-in sample event and its names are synthetic and
  do not describe real people.

Do not store sensitive personal information (health details, contact data)
in volunteer names or labels; browser storage is not encrypted by the app.

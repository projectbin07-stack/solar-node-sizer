# Security policy

## Supported versions

Only the latest release and the version deployed on GitHub Pages receive fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use the private
vulnerability reporting of this repository on GitHub (Security tab, "Report a
vulnerability"):
https://github.com/projectbin07-stack/solar-node-sizer/security/advisories/new

Include what you found, how to reproduce it and the version or commit. This is
a spare-time project maintained by one person, so there is no guaranteed
response time.

## Scope

The web page is static. It makes no network requests after loading its own
files and sends no data anywhere. A PVGIS file you choose is read inside the
browser with the File API and is never uploaded. URL parameters are parsed as
numbers or matched against fixed lists; load-state names are inserted as text,
never as HTML. The page stores nothing (the theme choice lives in the URL).
"Copy link" writes the current URL to the clipboard and "Export CSV" creates a
local download.

The CLI reads the configuration and PVGIS files you name, writes a file only
when given `--csv <file>`, and opens no network connections.
`scripts/serve.js` is a development server bound to 127.0.0.1; do not expose
it to a network.

## Not a safety component

Results are model estimates with illustrative presets and have not been
validated against measured data from real hardware. Do not rely on them alone
for systems where an outage is dangerous or costly; measure your node and
battery, and leave margin. Battery charging limits and protection (cell
temperature, over-voltage, over-current) must be handled by proper hardware.

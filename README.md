# 3DWeather Aviation Data

Public, browser-ready aviation snapshots for the private 3DWeather application.

The repository keeps the builders, validation tests, and GitHub Actions workflows
public. Generated snapshots are published by replacing assets on the fixed
[`aviation-live-data`](../../releases/tag/aviation-live-data) prerelease, so
routine updates do not grow Git history.

## Release assets

| Asset | Source | Update check |
|---|---|---|
| `tfr.js` | FAA Temporary Flight Restrictions | Hourly at minute 17 |
| `sigmet.js` | Aviation Weather Center SIGMET, CWA, and Convective SIGMET Outlook products | Every 5 minutes |
| `airmet.js` | Aviation Weather Center G-AIRMET hazards and freezing levels | Every 5 minutes |
| `pja.js` | FAA NASR parachute jumping areas | Weekly |

Every workflow restores the last published asset before building, validates all
four classic scripts, skips byte-identical updates, and uploads only its own
assets. AWC publishing stages each replacement before swapping names so a
transient GitHub upload failure cannot delete the currently published snapshot.
The release is public and can be consumed without GitHub authentication.

The data is provided as-is from the cited official sources. It is for
visualization and must not be used as a substitute for official preflight
briefing or operational aeronautical information.

# 3DWeather Aviation Data

Public, browser-ready aviation snapshots for the private 3DWeather application.

The repository keeps the builders, validation tests, and GitHub Actions workflows
public. Generated snapshots are published by replacing assets on the fixed
[`aviation-live-data`](../../releases/tag/aviation-live-data) prerelease, so
routine updates do not grow Git history.

Slow-changing airport and airspace baselines are published separately. The fixed
[`aviation-base-data`](../../releases/tag/aviation-base-data) prerelease contains
only a stable manifest and the current compact NAVAID index. Each manifest points
to an immutable, internally consistent `aviation-base-<run>` release containing
FAA/OurAirports point tables and spatially partitioned airspace/airport-map data.

## Release assets

| Asset | Source | Update check |
|---|---|---|
| `tfr.js` | FAA Temporary Flight Restrictions | Hourly at minute 17 |
| `sigmet.js` | Aviation Weather Center SIGMET, CWA, and Convective SIGMET Outlook products | Every 5 minutes |
| `airmet.js` | Aviation Weather Center G-AIRMET hazards and freezing levels | Every 5 minutes |
| `pja.js` | FAA NASR parachute jumping areas | Weekly |

## Base data assets

The weekly `Update aviation base data` workflow publishes:

- compact FAA and OurAirports airport tables;
- the global OurAirports runway table;
- a compact FAA NAVAID index reused by the weather builder;
- combined 5-degree Class/Special Use/E airspace regions;
- combined 5-degree apron, taxiway, runway, and building regions.

The browser reads the stable manifest first and then immutable JSON assets. Direct
FAA ArcGIS and OurAirports requests remain failure-only fallbacks.

The current full build is about 44 MiB across 206 immutable release assets. Region
files are clipped and simplified locally to about five-meter tolerance; source
queries intentionally retain full geometry because the FAA Class Airspace service
returns null geometry when ArcGIS server-side offset simplification is requested.

Every workflow restores the last published asset before building, validates all
four classic scripts, skips byte-identical updates, and uploads only its own
assets. AWC publishing stages each replacement before swapping names so a
transient GitHub upload failure cannot delete the currently published snapshot.
The release is public and can be consumed without GitHub authentication.

The data is provided as-is from the cited official sources. It is for
visualization and must not be used as a substitute for official preflight
briefing or operational aeronautical information.

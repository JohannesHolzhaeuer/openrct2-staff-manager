# Copilot Instructions

## Project Guidelines
- In this OpenRCT2 plugin, do not rely on FootpathElement/EntranceElement.ride as a sentinel to distinguish park entrances from ride entrances/exits, since a park entrance can share the same ride id as an unrelated ride. Instead, build the set of real ride entrance/exit tiles from map.rides[*].stations[*].entrance/exit (dividing by 32 to convert to tile coords).
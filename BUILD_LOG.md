# Build log

Everything here was built at Junction 2026, after hacking opened on Friday 13 November at 19:30. Times are Helsinki time. The git history has the same story commit by commit.

## Friday

- **19:30** Hacking opens. Read Cala's challenge and API.
- **Evening** Tried ideas against Cala's real data before writing any product code (`research/tools/`). The one that held: an investor's rounds come back with a lead flag and sources in a single call, so "who led the rounds this investor followed" is one hop in the graph and impossible to get from web search.

## Saturday

- **01:49** First version of the backend: the walk from the investors who said yes to the leads of the rounds they joined, the API, drafts, says vs did, Slush.
- **02:15** Slush attendee directory through Slush's MCP. One investor held as several entities in Cala is merged into one record.
- **02:45** A second pass through Cala's knowledge search when the graph is thin for an investor.
- **03:16** Soft Yes becomes an MCP server itself. A warning when a name matches the wrong entity.
- **03:35** Public at soft-yes.fly.dev. The app runs on Fly with its own cache on a volume.
- **03:41** First frontend: the walk drawing itself, the ranked leads, the tools on each lead.
- **04:00** Confidence tiers, a source on every fact, cautions on stale facts.
- **Night** First test with outside reviewers. They all said the same thing: the product repeated Cala's "led" flags without checking them, and some were wrong.
- **07:25** The page check. Every "led" is re-read on the page Cala cites. Confirmed with the sentence, corrected with the sentence, or "the page does not say". The audit page and "Check a company".
- **07:52** Page check in the UI. A page older than its round can no longer confirm that round.
- **08:08** Quotes read the way the page does. The picker takes the top match on Enter only when the name starts with what was typed.
- **Morning** Says vs did moves onto the lead rows: the fund's own sentence next to what Cala shows it did, for the first five leads. Oxylabs search finds a fund's site when Cala has none. One visitor can no longer spend everyone's Cala credits. Names typed with markup are searched as plain words.

## How it was built

Written with Claude Code. The facts come from Cala; no model states one. Where a model writes (the intro request) or points (a fund's own sentences), code checks the result against the facts or the page.

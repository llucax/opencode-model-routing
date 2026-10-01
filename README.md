# opencode model routing

Picks a provider, model and effort for an [OpenCode](https://opencode.ai) subagent or session. It reads a data file with your own measurements of each model at each effort, a configuration with the providers you have and how you prefer them, what the providers offer and how much of their quota is left, and returns the best route for a job. The same routing core has two frontends: the `model_route` tool, an OpenCode plugin that agents call, and the `model-route` command, for people and scripts.

The repository ships no measurements. [`examples/`](examples/) has a configuration and a data file with invented values to show the formats; you bring your own data, from any benchmark or judgment you trust.

## Sections

- [Installation](#installation): the plugin and the command, and what they need.
- [Configuration](#configuration): where the file is, and each of its tables.
- [Formulas and predicates](#formulas-and-predicates): the expression language that scores, costs, ranks and filters routes, and how to tune a value formula.
- [Data file](#data-file): the CSV format, and how its models are matched to your providers.
- [The model_route tool](#the-model_route-tool): its parameters, its output, and what it knows that the command doesn't.
- [The model-route command](#the-model-route-command): options, `check`, `config` and exit status.
- [How routes are ranked](#how-routes-are-ranked): the filters, the ranking and the notes on each route.

## Installation

Both frontends run on [bun](https://bun.sh). Clone the repository and install its one dependency, the OpenCode plugin API:

```sh
git clone https://github.com/llucax/opencode-model-routing.git
cd opencode-model-routing
bun install --production
```

Add the plugin to the `plugin` list of your OpenCode configuration (`~/.config/opencode/opencode.json` or `opencode.jsonc`), with an absolute path or one relative to that file:

```json
{
  "plugin": ["/path/to/opencode-model-routing/src/plugin.ts"]
}
```

For the command, link `bin/model-route` into a directory on `PATH`. It is a POSIX sh wrapper that finds bun in `PATH` or in `~/.bun/bin`, so it works from anywhere:

```sh
ln -s "$PWD/bin/model-route" ~/.local/bin/
```

Then write your [configuration](#configuration) and [data file](#data-file), check them with `model-route check`, and restart OpenCode. Quota comes from the [opencode-quota](https://github.com/slkiser/opencode-quota) plugin: without it every spare is unknown, and providers rank only by preference.

OpenCode's TUI shows only the name and arguments of a plugin tool by default. Its "Show generic tool output" toggle (in the command palette, or the `session_toggle_generic_tool_output` keybind, unbound by default) also shows the first three lines of each call's output, where the route is.

## Configuration

The configuration holds everything written by hand. It is the first found of these, whole and never merged:

1. The file given with `--config` (command line only).
2. The file in `$MODEL_ROUTING_CONFIG`, when it is not empty.
3. `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/model-routing/config.toml`.

Start from [`examples/config.toml`](examples/config.toml), whose comments explain every key. Its tables:

| Table           | Holds                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`          | The data file: `~/...` from your home directory, anything else relative to the configuration file.                                                                                        |
| `[columns]`     | Optional: `include`, data columns to show even when no formula uses them.                                                                                                                 |
| `[formulas]`    | Named formulas: `score` (what ranges filter), `cost` and `value` (what ranks routes) are required, others are free. See [Formulas and predicates](#formulas-and-predicates).              |
| `[policy]`      | `prefer`, `prefer_min_spare`, `spare_step`, and the optional predicates `cheap` and `heavy`, explained in [How routes are ranked](#how-routes-are-ranked).                                |
| `[providers.*]` | One per OpenCode provider you have: `plan`, `max_heavy`, `quota_name`, `bounded_only`, `bounded` and `heavy` (predicates) and `window_overrides`. Only these providers are used.          |
| `[tags]`        | Tag names and what each means. Requests prefer models with the tags they ask for.                                                                                                         |
| `[jobs.*]`      | What agents ask for: a `score` range (`A-B`, or `A+` for at least A), optional `tags`, an `about` line, and optionally a `value` formula to rank by and a `where` predicate to filter by. |
| `[[model]]`     | Optional, per data model: `id`, its `tags`, and `ids`, its exact ID at a provider when matching doesn't find it.                                                                          |
| `[[exclude]]`   | Routes never offered: `model`, optional `effort` (without it, every effort) and `reason`.                                                                                                 |

Everything is validated strictly: a wrong type, an out of range number or an unknown key is an error, and every problem is reported at once, prefixed with the file. Model references (`[[model]]`, `exclude`, `bounded_only`, `window_overrides`) use the data's model IDs and must be in the data.

The tool reads the configuration on every call, so changes apply at once, except for the jobs its description lists and its `job` parameter accepts, which need an OpenCode restart.

Version 1's `columns.use`, `columns.score`, `columns.cost`, `policy.cheap_cost`, `policy.heavy_score` and `providers.*.bounded_above_cost` are gone: each is an error saying what replaces it.

## Formulas and predicates

Formulas and predicates are expressions over the data's columns, written as TOML strings:

```toml
[formulas]
score = "intelligence"
cost = "cost_per_task"
value = "score - 60 * log2(cost)"
lean = "value - 30 * log2(tokens_per_task / 10000)"

[policy]
cheap = "cost <= 0.60"
heavy = "score >= 780"

[jobs.hard]
score = "780-880"
value = "lean"
where = "time_per_task < 900"
about = "hard or ambiguous work, design, reviewing another model's output"
```

A formula gives a number and a predicate gives a truth value. Every place in the configuration takes one or the other, and giving the wrong one is an error: `value = "cost <= 0.5"` fails with "a formula must give a number, this is a comparison".

| Place                     | Kind      | Used for                                                                       |
| ------------------------- | --------- | ------------------------------------------------------------------------------ |
| `formulas.score`          | formula   | Score ranges, and how far the nearest routes are from them.                    |
| `formulas.cost`           | formula   | Shown as the cost, and the tie-break after the value.                          |
| `formulas.value`          | formula   | The ranking, higher first, unless the job or the request gives another.        |
| other `formulas.*`        | formula   | Anything: other formulas, a job's `value`, `--value`.                          |
| `jobs.*.value`, `--value` | formula   | The job's or the request's ranking, instead of `formulas.value`.               |
| `policy.cheap`            | predicate | Cheap routes rank ahead of the preferred providers. Absent, no route is cheap. |
| `policy.heavy`            | predicate | Heavy routes count against `max_heavy`. Absent, no route is heavy.             |
| `providers.*.heavy`       | predicate | The provider's own `heavy`, instead of the policy's, for its routes.           |
| `providers.*.bounded`     | predicate | The provider's routes it holds for are for bounded work only.                  |
| `jobs.*.where`, `--where` | predicate | Only routes it holds for are offered.                                          |

### The language

- Numbers, as `42`, `0.5` or `1e3`, and names: a data column or a named formula. A formula can't have a data column's name, and formulas can't refer to themselves, directly or through others.
- Arithmetic: `+`, `-`, `*`, `/` and `^`, with the usual precedence. `^` is right-associative and binds tighter than a leading minus, so `-2^2` is -4. Parentheses group.
- Functions: `log` (natural), `log2`, `log10`, `sqrt`, `abs`, and `min` and `max` of two or more arguments.
- Comparisons, for predicates: `<`, `<=`, `>`, `>=`, `==` and `!=`, between numbers. They don't chain: write `a < b and b < c`.
- `and`, `or` and `not` join comparisons; `not` binds looser than a comparison, so `not a < b` is `not (a < b)`.

The expressions are parsed and evaluated by this repository's own code, never by JavaScript's, and have no way to reach anything but the row's numbers.

An error says where it is and at which column of the expression, as `policy.cheap: column 1: unknown name "cots", neither a data column nor a formula`.

### When they are computed

Every formula and predicate is computed once per data row, when the data is loaded, from that row's columns alone: never from the quota, the providers or the request, so every route's values are known before routing starts. A result that isn't a finite number, as `log2(0)` or a division by zero, anywhere in an expression, is an error naming the row as `file:line`, the key and the column, like a bad cell; `model-route check` reports every one.

Routing reads only the columns some formula or predicate uses, through the formulas they refer to, plus `columns.include` and the columns of `--value` and `--where`. Each of these must hold a number in every row; any other column is ignored.

### Tuning a value formula

A value formula sets how much score a cost must buy. With `value = "score - 60 * log2(cost)"`, a route costing twice as much must score 60 points more to rank the same, so a much better model wins over a slightly cheaper one, and a slightly better one doesn't win over one far cheaper. `value = "-cost"` ranks by cost alone.

Value ranks routes after provider standing and tags (see [How routes are ranked](#how-routes-are-ranked)), so it decides among routes of the same standing. Try a formula on the command line before writing it into the configuration:

```sh
model-route --job hard --limit 0 --value "score - 40 * log2(cost)"
model-route --job hard --limit 0 --value lean --where "time_per_task < 600"
```

## Data file

The data is a CSV file ([RFC 4180](https://www.rfc-editor.org/rfc/rfc4180)) with a header row and one row per model and effort, so a scraper or a spreadsheet can produce it and it diffs well:

```csv
model,vendor,effort,date,intelligence,cost_per_task,tokens_per_task,time_per_task
claude-opus-5-5,anthropic,xhigh,2030-01-15,820,22.00,140000,1700
gpt-6-luna,openai,medium,2030-01-15,610,0.30,40000,350
```

- `model` is the model's ID, `vendor` who makes it (second opinions prefer other vendors), and `effort` one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. All three are required.
- `date` is optional, as `YYYY-MM-DD`; the oldest is shown as the data's snapshot.
- Every other column is yours. The ones the formulas and predicates use, and those in `columns.include`, must hold a finite number in every row, since routing never deals with missing values; the rest are ignored.
- Every row is a candidate route: a new model in the data routes without touching the configuration.

A problem is reported as `file:line: ...`: a malformed CSV, a duplicate header, a missing or non-numeric value, an unknown effort, two rows for the same model and effort, or one model with two vendors.

### How models are matched to providers

A data model is offered at each configured provider whose catalog has its ID, compared lowercase with `.` and `-` equal, so `claude-opus-5-5` in the data matches `github-copilot/claude-opus-5.5`. An `ids` entry in the model's `[[model]]` table is exact and wins, for a provider whose ID differs otherwise. Two IDs at one provider that match the same data model are an error asking for such an entry. `model-route check` lists the data models none of your providers offer, so a missing entry shows up instead of hiding a model.

A route is offered only when the provider has its effort: the model's OpenCode variants must include it. `none` needs no variant.

## The model_route tool

The tool's description lists your jobs, so agents know them without loading anything else. Its parameters:

| Parameter   | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `job`       | One of the configured jobs: its score range and tags.                                          |
| `score`     | `A-B` or `A+`, replacing the job's range.                                                      |
| `tags`      | Tags to prefer, replacing the job's, even when empty.                                          |
| `need`      | Required capabilities; only `vision` for now.                                                  |
| `not_model` | Models to avoid, as a data ID or `provider/ID`, for second opinions: other vendors rank first. |
| `limit`     | How many routes to return, 0 for all; default 1.                                               |

`job` or `score` is required. The output starts with the route, then the quota, then what the agent must keep in mind:

```text
anthropic/claude-opus-5-5 xhigh (value 552.43, intelligence 820, cost_per_task 22, tokens_per_task 140000, time_per_task 1700): heavy, 1 of 2 running on anthropic; missing tags: review
quota: anthropic spare +12, openai spare -30, github-copilot spare -5
Long-running workers count as heavy too.
```

Each route shows its value, then the [shown columns](#the-model-route-command). When the first line would be too long for the TUI's three-line preview, the route keeps only its value, or no metrics at all, so its notes stay visible.

When nothing matches, it says what removed the routes and which came closest, and tells the agent to fix the cause or ask the user instead of picking a model another way.

The tool knows two things the command doesn't, from the running OpenCode:

- The models the connected providers actually expose, with their variants, instead of the full catalog in `~/.cache/opencode/models.json`.
- The heavy sessions running now. It counts every busy or retrying session on this OpenCode server, in any directory, whose model and effort make a heavy route, yours included, and skips the heavy routes of a provider already running its `max_heavy`. A session's model and effort are those of its latest prompt. Sessions of other OpenCode servers aren't seen, two agents routing at the same moment can both pass, and a long-running session on a route that isn't heavy isn't counted, so the output reminds the agent that long-running workers count as heavy too.

## The model-route command

```sh
model-route --job implement                  # the best route for a job
model-route --score 600-720 --tags impl      # a range and tags instead
model-route --job hard --limit 0             # every route for the job
model-route --job hard --not-model anthropic/claude-opus-5-5
model-route --job hard --value "score - 40 * log2(cost)"   # try another value formula
model-route --job hard --where "time_per_task < 600"      # only faster routes
model-route --need vision --json             # only models that take images, as JSON
model-route                                  # every route, ranked
model-route check                            # validate everything, find stale mentions
model-route config                           # show the configuration in use
```

The output starts with one line of quota per configured provider, then a table of routes, then a summary of the request and how many routes each filter removed. The table has `provider/model`, effort, the value, the shown columns, spare, tags and notes. The shown columns are `columns.include` and those the request's score, cost, value and `where` use, in the data's order, plus a `score` or `cost` column of their own when that formula isn't a bare column.

| Option                      | Meaning                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--job NAME`                | A configured job: its score range and tags.                                                                                                                                                                                                                                                            |
| `--score A-B`, `--score A+` | Score range, replacing the job's. Routes below it are never offered; routes above it only when nothing is in range.                                                                                                                                                                                    |
| `--tags a,b`                | Tags to prefer, replacing the job's, even when empty (`--tags ''`). An unknown tag is an error that lists the known ones.                                                                                                                                                                              |
| `--need vision`             | Require a capability; repeat or use commas.                                                                                                                                                                                                                                                            |
| `--not-model X`             | Avoid a model, by data ID or `provider/ID`; other vendors rank first. Repeat or use commas. A value matching nothing is a warning.                                                                                                                                                                     |
| `--limit N`                 | How many routes to print, 0 for all. Default: 1 with `--job` or `--score`, else all.                                                                                                                                                                                                                   |
| `--value EXPR`              | Rank by this formula, or a formula's name, instead of the job's `value` or `formulas.value`.                                                                                                                                                                                                           |
| `--where EXPR`              | Offer only routes this predicate holds for, instead of the job's `where`.                                                                                                                                                                                                                              |
| `--json`                    | One JSON object, `version` 3: `snapshot`, `columns`, `formulas`, `shown`, `request` (with its effective `score`, `value` and `where`), `warnings`, `quota`, `routes` (each with its `value` and `shown` values), `aboveRange`, `found` (counts before the limit), `removed`, `excluded` and `nearest`. |
| `--config FILE`             | The configuration, instead of `$MODEL_ROUTING_CONFIG` or the default path. Also applies to `check` and `config`.                                                                                                                                                                                       |
| `--data FILE`               | The data, instead of the configuration's `data`.                                                                                                                                                                                                                                                       |
| `--models-json FILE`        | Provider catalog. Default: `~/.cache/opencode/models.json`. Without a readable catalog nothing can be matched, which is an error.                                                                                                                                                                      |
| `--quota-json FILE`         | Saved `opencode-quota show --json` output. Default: run the opencode-quota CLI OpenCode's configuration pins, else the newest installed.                                                                                                                                                               |
| `--now ISO`                 | The time to compute spare at, for replays and tests.                                                                                                                                                                                                                                                   |

Exit status is 0 with routes, 2 when nothing matches (the output then shows the nearest routes and why each is out), and 1 for errors. Errors are `model-route: ...` lines on stderr. Warnings go to stderr as `warning: ...`, and into `warnings` with `--json`.

`model-route config [--json]` prints the configuration file and how it was found, the data file with its row count and snapshot, and the effective configuration, every formula and predicate included.

### Checking

`model-route check [--config-dir DIR]` validates the configuration and its data together, every formula and predicate computed for every row, and reports:

- Configured providers the catalog doesn't have, `ids` entries it doesn't have, ambiguous matches, and data models none of the configured providers offer.
- In `AGENTS.md`, `agents/*.md`, `skills/*/SKILL.md` and `tool-instructions/*.md` under the OpenCode configuration directory (default `~/.config/opencode`): mentions of `provider/model` at a configured provider that aren't a data model's ID there, `--score` ranges no route meets, unknown tags after them, and unknown jobs in `--job NAME`, ``job: `NAME` `` or `` `job: NAME` ``.

It prints one problem per line and exits 1 if there are any, else one OK line.

`model-route check --data FILE` validates a data file alone, without a configuration, catalog or quota, for a data repository's CI: its format, and a number in every row of every column but `model`, `vendor`, `effort` and `date`.

## How routes are ranked

Every data row at every configured provider that has its model is a candidate. The filters run in order, each counted in the output: excluded by `[[exclude]]`, effort not offered, missing a needed capability, the same model as `not_model`, heavy at a provider at its limit (tool only), exhausted quota, failing the request's `where`, below the range, above the range. `where` applies above the range too, before the fallback to routes above it. A route `where` removed can still be among the nearest when nothing matches, with "fails where" among its reasons. Data rows that no configured provider has are counted as `no provider`. Then the ranking:

1. With `not_model`, other vendors first.
2. Provider standing. A route whose spare is at least `prefer_min_spare` goes first if it is cheap (`policy.cheap` holds and it has every requested tag), then by the provider's place in `prefer`. Below that, routes rank by spare in steps of `spare_step` points. Unknown spare goes last.
3. Requested tags the model has, more first.
4. The value, higher first: the job's `value`, else `formulas.value`, or `--value`.
5. Cost, then score, then the route's name, so ties are stable.

With `value = "-cost"`, the order is version 1's, which ranked by cost.

Spare is the percent of a quota window remaining minus the percent of the window still to run, and a route's spare is the worst of the windows that apply to its model. A window's length comes from the quota data, else from the provider's `window_overrides`; a window with no known length is ignored with a warning.

The notes on a route don't change its rank:

- `bounded work only`: the model is in the provider's `bounded_only`, or the provider's `bounded` holds for the route. One bounded job, never a loop or a long session.
- `heavy`: the provider's `heavy` holds for the route, or `policy.heavy` when the provider has none, since a provider's own predicate replaces the policy's: a score that is heavy at one provider can cost little at another, so cost based thresholds usually differ. The command shows the provider's `max_heavy`; the tool shows how many heavy sessions run there, counting a running session when its provider's `heavy` holds for its model at its effort, or for any effort of the model when its effort isn't in the data.
- `missing tags: ...`, and `above range` when nothing was in range.

## Development

```sh
bun install
bun test
bun run typecheck
```

The tests use synthetic fixtures only, with invented models and values.

## License

[MIT](LICENSE).

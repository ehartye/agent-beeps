# beeps family: N patches from a template and a table

```
beeps family <template.json> --table rows.csv|rows.json  [--row "k=v,k=v" ...]
  [--jitter /pointer=0.05 ...] [--seed 1] [--out <dir>] [--save] [--force]
  [--dry-run] [--lint] [--set <name> [--prompt "..."]]
```

The template is a patch whose strings may hold `{{param}}`. A string that is only a placeholder takes
the cell's type (`"cutoff": "{{body}}"` becomes a number); inside longer text it is substituted as
text (`"step-{{surface}}"`). Built-in params: `{{index}}` (1-based) and `{{count}}`.

Each row (CSV header row, JSON array of objects, or repeated `--row`) supplies:

- `name`, `family`: set the patch name/family (otherwise the template's, after substitution).
- `tags`: appended to the template's tags, `soft|outdoor` or a JSON array.
- any other column: a param for the placeholders (warned about if nothing uses it).
- a column starting with `/`: a JSON-pointer override applied after substitution, e.g.
  `/layers/0/amp/decay`, `/duration`. Works on fields the template never mentioned.
- a cell `a..b` (numbers): a value drawn from that range, once per row and column. `--jitter
  /layers/0/source/pitch=0.04` instead scales the number at that pointer by up to +/-4% per row.

Draws depend only on `--seed`, the row's name (or index) and the column, so reruns are identical and
adding or removing other rows never moves a row's numbers. Output patches are ordinary patch JSON.

Every row is parsed with the real schema before anything is written. A bad row fails the whole
command with `E_SCHEMA`, the patch `pointer`, and `rows: [{row, name, message, pointer, hint}]`
for every failing row. Names must be distinct; existing files need `--force` (`E_CONFLICT`).

Where it writes: the project's patches by default; `--out <dir>` writes `<name>.json` files to a
folder (the repo's committed patches) instead, `--save` adds the project too. `--dry-run` writes
nothing. `--lint` lints every patch like `beeps lint --brief` (findings only, clean ones named; exit 1
on lint errors) so attack-floor, no-dc, tick-length and tail-ceiling show up per row at once.
`--set steps` renders the patches into a candidate set for `beeps audition open --flow explore`.

## Example: 12 footsteps from a surface table

step.json:

```json
{ "schema": "beeps/patch@1", "name": "step-{{surface}}", "family": "footstep", "tags": ["repeating", "foley"], "duration": 0.22,
  "layers": [
    { "source": { "type": "noise", "color": "brown" }, "amp": { "attack": 0.004, "decay": "{{decay}}", "sustain": 0, "release": 0.03 },
      "filter": { "type": "bandpass", "cutoff": "{{body}}", "q": 0.8 } },
    { "source": { "type": "noise", "color": "white" }, "amp": { "attack": 0.004, "decay": 0.03, "sustain": 0, "release": 0.01 },
      "filter": { "type": "highpass", "cutoff": "{{crunch}}", "resonanceDb": 0 }, "gainDb": "{{crunchDb}}" }
  ],
  "variation": { "gainDb": 1, "variants": 4, "noRepeat": true }, "meta": { "priority": 2, "intent": "oneshot" } }
```

surfaces.csv:

```
surface,body,decay,crunch,crunchDb,tags
grass,500,0.10,3000,-24,soft
gravel,800,0.07,3500,-12,loud
stone,1200,0.06,3000,-18,hard
metal,2200,0.06,6000,-14,hard
```

```
beeps family step.json --table surfaces.csv --jitter /layers/0/amp/decay=0.1 --seed 3 --lint --out audio/patches
```

On the full twelve-row table lint flagged `sharpness-warn` on gravel, tile and metal (and an
attack-floor error before the second layer's attack went from 0.002 to 0.004). Fix the template or
override just that row with a `/layers/1/gainDb` column, rerun with `--force`, and keep the table in
the repo: it is the source, the patches are output. `beeps kit add` each name and `beeps kit check`
afterwards, since kit-level rules do not run in lint.

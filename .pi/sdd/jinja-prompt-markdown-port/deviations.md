# Deviations: jinja-prompt-markdown-port

## Prompt-text deviations

None. Every migrated renderer matches the pre-port golden byte for byte. The
goldens in `tests/fixtures/sdd-golden/` were captured from the hand-rolled code
before the port, and `tests/jinja-golden.test.ts` asserts equality.

The only rendering-mechanism change is in `agent/extensions/lib/jinja.ts`: the
library strips a trailing newline from the template source before parsing, but
loop bodies and substituted values can still leave one in the output. The loaded
strips that newline so rendered text keeps the pre-port no-trailing-newline
shape. Without it every list-ended report gained a newline.

## Documented behaviour changes

- `demoteHeadings` is now fence-aware. Lines inside a ``` fence keep their
  original heading level instead of being demoted. The spec requires this, the
  old regex did not do it, and no test pinned the old behaviour. A new test in
  `tests/sdd.test.ts` covers it. An unbalanced fence in agent-authored text (an
  odd number of ``` lines in a verification report) leaves later headings
  un-demoted, exactly as the same fence desynchronizes `sectionBounds`; the two
  stay consistent.
- `demoteHeadings` is line-based now. The old `/^(#{1,5})\s/gm` regex treated the
  `\n` as the required whitespace, so a line of bare hashes merged with the next
  line (`###\ntext` became `#### text`). The line-based version requires the
  space on the same line and leaves a bare `###` line alone. This is a fix, not a
  regression, and no caller passes bare-hash lines.
- The shared template loader lives at `agent/extensions/lib/jinja.ts`, not
  `agent/extensions/jinja.ts` as the plan wrote. Pi loads every top-level `.ts`
  file under `agent/extensions/` as an extension, so the planned path made
  `tests/resources.test.ts` fail with "does not export a valid factory
  function". A subdirectory file is not loaded as an extension. The intent (one
  cached loader read by `sdd/` and `verification/`) is unchanged.
- `replaceSection`'s section scanning, heading matching and error strings are
  unchanged from the pre-port code. They stay in TypeScript because
  `@huggingface/jinja` exposes no custom filter or test API and no split filter.

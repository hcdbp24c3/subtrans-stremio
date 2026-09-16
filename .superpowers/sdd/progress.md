# SDD ledger — plan: docs/superpowers/plans/2026-09-16-stremio-subtitle-alignment-addon.md

## Pre-flight Scan

| Tasks | Shared Files/Interfaces | Finding | Ruling |
|-------|------------------------|---------|--------|
| T2 → T4 | `SubtitleEntry` type | T4 defines it, T5 re-exports it | OK — aligner imports from parser |
| T2 → T8 | `AddonConfig`, `decodeConfig` | T8 consumes T2 output | OK — clean dependency |
| T4 → T5 | `SubtitleEntry` | T5 re-defines same interface | Ruling: aligner defines own type, parser has own — OK for decoupling |
| T6 → T7 | Config query param format | Both use same encoding | OK — consistent |
| T8 → T4,T5 | Parser + Aligner imports | T8 uses both | OK — clear dependency chain |

Scan clean. Proceeding with execution.

## Task Progress

# shared/

Cross-cutting types/constants shared across layers (e.g. the license-status enum, role names) that have no business meaning of their own — just shapes multiple layers need to agree on. If a file here starts making decisions rather than describing shapes, it belongs in `services/` instead.

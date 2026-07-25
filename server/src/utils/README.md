# utils/

Small, pure, reusable helpers with no business meaning (string/date formatting, ID generation, etc.) — the kind of thing that should never be duplicated across repositories/services because it was easier to inline than to import. If a helper starts encoding a business rule (e.g. "how long is a trial"), it belongs in `services/`, not here.

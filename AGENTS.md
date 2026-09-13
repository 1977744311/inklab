# InkLab standalone boundary

InkLab must install and test without any sibling product repository. Keep generic probes and fixtures here; product assertions and device control scripts belong to their owning applications. Resolve optional adapters from the selected application configuration.

Run `npm test` for host changes and a relevant browser scenario for runtime integration changes. Runtime binaries are external cache artifacts verified against lockfiles; source and test distributions contain the host, fixtures and lock metadata.

# InkLab standalone boundary

InkLab must install and test without any sibling product repository. Keep generic probes and fixtures here; product assertions and device control scripts belong to their owning applications. Resolve optional adapters from the selected application configuration.

Run `npm test` for host changes and a relevant browser scenario for runtime integration changes. Runtime binaries (`.engine/`) and the runtime list (`runtimes.lock.json`) are local, git-ignored state, with the binaries verified by SHA-256; source and test distributions contain the host and fixtures only.

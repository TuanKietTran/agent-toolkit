# Dev tools

- `/gc-replay` — builds a scratch directory with old and fresh files, runs the real scan and sweep code on it, and prints PASS/FAIL. Checks that only stale `auto` files are removed, and that `never` and `confirm` categories are left alone. Does not touch real pi assets or the shared `/gc` state.

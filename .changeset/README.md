# Changesets

Every PR that changes a published package (`@tiklive/*`) should include a changeset:

```sh
bunx changeset
```

Pick the packages and bump type, write a one-line summary for the changelog, and commit the
generated file. The four packages are versioned together. See CONTRIBUTING.md › Releasing.

A GitHub action that lets code-owners merge PRs via a comment.

This action uses the standardized structure of [a CODEOWNERS file](https://github.blog/2017-07-06-introducing-code-owners/) to handle the access controls. 

This repository is forked from [OSS-Docs-Tools/code-owner-self-merge](https://github.com/OSS-Docs-Tools/code-owner-self-merge). 

Main difference is that it adds less comments to PRs and it also allows for multiple code owners to approve a PR for it to be merged.

## A simple example

So, with this file at: `.github/CODEOWNERS`:

```sh
README.md @casassg
```

## Setting It Up

You want a unique workflow file, e.g. `.github/workflows/codeowners-merge.yml`

```yml
name: Codeowners merging
on:
  pull_request_target: { types: [opened, synchronize] }
  issue_comment: { types: [created] }
  pull_request_review: { types: [submitted] }
  check_suite: {types: [completed]}

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v1
      - name: Run Codeowners merge check
        uses: casassg/code-owner-self-merge@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Then you should be good to go.

### Security

We force the use of [`pull_request_target`](https://github.blog/2020-08-03-github-actions-improvements-for-fork-and-pull-request-workflows/) as a workflow event to ensure that someone cannot change the CODEOWNER files at the same time as having that change be used to validate if they can merge.
### Extras

You can use this label to set labels for specific sections of the codebase, by having square brackets to indicate labels to make: `[label]`

```sh
# Collaborators for Spanish Translation of the Website
packages/playground-examples/copy/es/**/*.md @KingDarBoja [translate] [es]
packages/playground-examples/copy/es/**/*.ts @KingDarBoja [translate] [es]
packages/tsconfig-reference/copy/es/**/*.md @KingDarBoja [translate] [es]
packages/typescriptlang-org/src/copy/es/**/*.ts @KingDarBoja [translate] [es]
packages/documentation/copy/es/**/*.ts @KingDarBoja [translate] [es]
```

## Config

There are four options available at the moment:

- `cwd`, which can be used to determine the root folder to look for CODEOWNER files in.
- `merge_method`, which can be `merge` (default), `squash` or `rebase`, depending on what you want the action to do.

```yml
- name: Run Codeowners merge check
  uses: OSS-Docs-Tools/code-owner-self-merge@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    cwd: './docs'
    merge_method: 'squash'
```

### Dev

<!-- Use `npx jest --watch` to run tests. -->

### Deploy

Use the GH UI to make a tag and release

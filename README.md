# auto-merge-bot

A GitHub action to manage pull requests automatically via comments from CODEOWNERS.

Heavily inpired by functionality from [prow-bot](https://github.com/kubernetes/test-infra/tree/master/prow) and based on the exiting GitHub action
[OSS-Docs-Tools/code-owner-self-merge](https://github.com/OSS-Docs-Tools/code-owner-self-merge).

## Known Limitations

- PRs from forks modifying `.github/workflows` are not supported. [casassg/auto-merge-bot#1](https://github.com/casassg/auto-merge-bot/issues/1)
- PR review comments for forks are not supported. [casassg/auto-merge-bot#3](https://github.com/casassg/auto-merge-bot/issues/3)

## Code ownership

This action uses the standardized structure of [a CODEOWNERS file](https://github.blog/2017-07-06-introducing-code-owners/) to handle the access controls.

In addition, it will try to assign the pull request to a person to review based on their current load of assigned reviews in the repo.

## Commands available

- `/lgtm`: Approve a pull request. Code owners can use this to approve the pull request. If no code owner can be found other than author, any user can then approve the pull request.
- `/merge`: Request automatic merging of a pull request. Code owners can use this to request automatic merging of the pull request. If no code owner can be found other than author, any user can then request automatic merging of the pull request.

## When is a PR merged?

`auto-merge-bot` will validate the following:

- Pull request has been approved by a code owner for each of the changed files.
- Pull request has been requested to be automatically merged
- All checks are green in PR.

After this has been done, PR will be merged automatically.

## A simple example

So, with this file at: `.github/CODEOWNERS`:

```sh
README.md @casassg
```

The GitHub action will automatically merge pull requests approved that are made by the user `@casassg` to the file `README.md` and have been approved.

If another user tries to modify the file, `@casassg` will be tagged for review. Once user reviews and approves the change, the PR will be merged.

## Setting It Up

You want a unique workflow file, e.g. `.github/workflows/codeowners-merge.yml`

```yml
name: Codeowners merging
on:
  pull_request_target: { types: [opened, synchronize] }
  issue_comment: { types: [created] }

jobs:
  auto-merge-bot:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v0.3
      - name: Run Codeowners merge check
        uses: casassg/auto-merge-bot@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Then you should be good to go.

### Security

Using [`pull_request_target`](https://github.blog/2020-08-03-github-actions-improvements-for-fork-and-pull-request-workflows/) and `issue_comment` as a workflow event to ensure that someone cannot change the CODEOWNER files at the same time as having that change be used to validate if they can merge.

## Config

There are four options available at the moment:

- `cwd`, which can be used to determine the root folder to look for CODEOWNER files in.
- `merge_method`, which can be `merge`, `squash` (default) or `rebase`, depending on what you want the action to do.
- `assign_reviewer`, which can be `true` or `false`, depending on whether you want the bot to assign the reviewer to the pull request.

```yml
- name: Run Codeowners merge check
  uses: casassg/auto-merge-bot@v0.3
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    cwd: "./docs"
    merge_method: "squash"
```

### Dev

- Install deps: `yarn install`
- Prepare distribution: `yarn run dist`

ToDo(casassg): add tests back.

<!-- Use `npx jest --watch` to run tests. -->

### Deploy

Use the GH UI to make a tag and release

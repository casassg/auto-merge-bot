// @ts-check

const { context, getOctokit } = require("@actions/github");
const core = require("@actions/core");
const Codeowners = require("codeowners");
const ourSignature = "<!-- Message About Merging -->";
const lgtmRegex = /\/lgtm/i;
const mergeRegex = /\/merge/i;
const mergeReadyLabel = { name: "merge-ready", color: "00ff00" };
const needsLgtmLabel = { name: "needs-lgtm", color: "FFA500" };
const needsMergeLabel = { name: "needs-merge", color: "FFA500" };
const needsManualMergeLabel = { name: "needs-manual-merge", color: "FFA500" };
const lgtmLabel = { name: "lgtm", color: "00FFFF" };
const allLabels = [
  mergeReadyLabel,
  needsLgtmLabel,
  needsManualMergeLabel,
  lgtmLabel,
  needsMergeLabel,
];
const ownersWillReviewMessage = `Thanks for the PR!  :rocket:

_Instructions:_ Approve using \`/lgtm\` and mark for automatic merge by using \`/merge\`.

<!-- Base message -->`;

function formatArray(arr) {
  return new Intl.ListFormat().format(arr);
}

async function getChangedFiles(octokit, repoDeets, prNumber) {
  // https://developer.github.com/v3/pulls/#list-pull-requests-files
  const options = octokit.pulls.listFiles.endpoint.merge({
    ...repoDeets,
    pull_number: prNumber,
  });

  /** @type { import("@octokit/types").PullsListFilesResponseData} */
  const files = await octokit.paginate(options);
  const fileStrings = files.map((f) => `/${f.filename}`);
  return fileStrings;
}

function getFilesNotOwnedByCodeOwner(owner, files, codeowners) {
  const filesWhichArentOwned = [];

  for (const file of files) {
    const relative = file.startsWith("/") ? file.slice(1) : file;
    let owners = codeowners.getOwner(relative);
    if (!owners.includes(owner)) {
      filesWhichArentOwned.push(file);
    }
  }

  return filesWhichArentOwned;
}

async function sendCommentUpdate(
  octokit,
  repoDeets,
  prNumber,
  comment_base,
  extra_comment
) {
  if (comment_base) {
    await octokit.issues.createComment({
      ...repoDeets,
      issue_number: prNumber,
      body: `${comment_base}

${extra_comment}`,
    });
  }
}

function isCommentValid(
  body,
  author,
  regex,
  owners,
  pr,
  extra_validation = false
) {
  return (
    !body.includes(ourSignature) &&
    (body.match(regex) || extra_validation) &&
    (owners.length === 0 || owners.includes("@" + author)) &&
    author !== pr.user.login
  );
}

function getCodeOwners(changedFiles, codeowners) {
  const owners = new Set();

  for (const file of changedFiles) {
    const relative = file.startsWith("/") ? file.slice(1) : file;
    const fileOwners = codeowners.getOwner(relative);
    fileOwners.forEach((o) => {
      if (o.startsWith("@")) owners.add(o);
    });
  }
  core.info(
    `Found ${formatArray(owners)} as owners of ${formatArray(changedFiles)}`
  );
  return Array.from(owners);
}

async function setLabels(octokit, repoDeets, labelConfigs, prNumber) {
  let label = null;
  const existingLabels = await octokit.paginate(
    "GET /repos/:owner/:repo/labels",
    { ...repoDeets }
  );
  for (const labelConfig of labelConfigs) {
    label = existingLabels.find((l) => l.name == labelConfig.name);
    // Create the label if it doesn't exist yet
    if (!label) {
      await octokit.issues.createLabel({
        ...repoDeets,
        name: labelConfig.name,
        color: labelConfig.color,
        description: labelConfig.description || "",
      });
    }
  }
  const labels = labelConfigs.map((l) => l.name);
  core.info(`Setting labels: ${formatArray(labels)}`);
  await octokit.issues.addLabels({
    ...repoDeets,
    issue_number: prNumber,
    labels: labels,
  });
  const removingLabels = allLabels
    .filter((l) => !labelConfigs.includes(l))
    .map((l) => l.name);
  for (const removingLabel of removingLabels) {
    core.info(`Removing label: ${removingLabel}`);
    try {
      await octokit.issues.removeLabel({
        ...repoDeets,
        issue_number: prNumber,
        name: removingLabel,
      });
    } catch (e) {
      core.info(`Failed to remove label ${removingLabel}`);
    }
  }
}

async function isCheckSuiteGreen(octokit, repoDeeets, pr) {
  let waitForCompletion = true;
  let inprogressRun = null;
  let failedRun = null;
  while (waitForCompletion) {
    let checkSuites = await octokit.checks.listForRef({
      ...repoDeeets,
      ref: `pull/${pr.number}/head`,
    });
    // Check if there's a run in progress or failed
    inprogressRun = checkSuites.data.check_runs.find(
      (s) => s.status === "in_progress" && s.name !== process.env.GITHUB_JOB
    );
    failedRun = checkSuites.data.check_runs.find(
      (s) =>
        s.status === "completed" &&
        !["success", "neutral"].includes(s.conclusion) &&
        s.name !== process.env.GITHUB_JOB
    );
    // if failed, returne false
    if (failedRun) {
      core.info(
        `Check suite status: ${failedRun.status} - Conclusion: ${failedRun.conclusion} (${failedRun.name})`
      );
      return false;
    }
    // if no in progress, then we are good to go!
    if (!inprogressRun) {
      waitForCompletion = false;
    }
    // Wait for a bit before checking again.
    else {
      core.info(
        `Check suite status: ${inprogressRun.status} - Conclusion: ${inprogressRun.conclusion} (${inprogressRun.name})`
      );
      core.info("Sleeping for 5000 ms");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return true;
}

async function assignReviewer(octokit, owners, repoDeeets, pr) {
  // Get a list of all open pull requests to current repository with base branch set as main
  const openPullRequests = await octokit.pulls.list({
    ...repoDeeets,
    state: "open",
    base: "main",
  });

  // Get a dictionary of users assigned to PRs as key and times assigned as value
  let assignedToPRs = {};
  openPullRequests.data.forEach((pr) => {
    pr.assignees.forEach((assignee) => {
      if (assignedToPRs[assignee.login]) {
        assignedToPRs[assignee.login] += 1;
      } else {
        assignedToPRs[assignee.login] = 1;
      }
    });
  });

  // Shuffle codeowners list to randomise who gets the assignation.
  // This is to prevent people from getting the same assignation every time.
  owners.sort(() => Math.random() - 0.5);

  // remove pr owner from list
  owners = owners.filter((o) => o !== "@" + pr.user.login);
  core.info(`Elegible reviewers: ${owners}`);

  // Randomly get a user to assign to this PR with the minimum number of PRs assigned to them
  let assignee = "";
  let minPRs = Number.MAX_SAFE_INTEGER;
  owners.forEach((user) => {
    if ((assignedToPRs[user] || 0) < minPRs) {
      assignee = user;
      minPRs = assignedToPRs[user];
    }
  });

  core.info(
    `Arbitrary choosen ${assignee} as assigned reviewer! PR assigned: ${minPRs}`
  );
  if (assignee !== "") {
    const assigneUsername = assignee.replace("@", "");
    await octokit.issues.addAssignees({
      ...repoDeeets,
      issue_number: pr.number,
      assignees: [assigneUsername],
    });
  }
  return assignee;
}

async function welcomeMessage(octokit, repoDeets, prNumber, message) {
  const comment = await hasPRWelcomeMessage(octokit, repoDeets, prNumber);
  if (comment) {
    if (comment.body.includes(message)) {
      core.info("PR Welcome message already exists");
      return;
    }
    await octokit.issues.updateComment({
      ...repoDeets,
      comment_id: comment.id,
      body: message + ourSignature,
    });
  } else {
    octokit.issues.createComment({
      ...repoDeets,
      issue_number: prNumber,
      body: message + ourSignature,
    });
  }
}

async function hasPRWelcomeMessage(octokit, repoDeeets, prNumber) {
  const comments = await octokit.issues.listComments({
    ...repoDeeets,
    issue_number: prNumber,
  });
  const hasMessage = comments.data.find((c) => c.body.includes(ourSignature));
  return hasMessage;
}

async function getApprovers(octokit, repoDeets, pr, owners) {
  const { data: comments } = await octokit.issues.listComments({
    ...repoDeets,
    issue_number: pr.number,
  });
  let users = [];
  comments.forEach((comment) => {
    if (
      isCommentValid(comment.body, comment.user.login, lgtmRegex, owners, pr)
    ) {
      core.info(`Found lgtm comment from ${comment.user.login}`);
      users.push(comment.user.login);
    }
  });
  const { data: reviewComments } = await octokit.pulls.listReviews({
    ...repoDeets,
    pull_number: pr.number,
  });
  reviewComments.forEach((comment) => {
    if (
      isCommentValid(
        comment.body,
        comment.user.login,
        lgtmRegex,
        owners,
        pr,
        comment.state === "APPROVED"
      )
    ) {
      core.info(`Found lgtm comment from ${comment.user.login}`);
      users.push(comment.user.login);
    }
  });
  return users;
}

async function hasMergeCommand(octokit, repoDeeets, pr, owners) {
  const comments = await octokit.issues.listComments({
    ...repoDeeets,
    issue_number: pr.number,
  });
  let hasMergeCommand = comments.data.find((c) =>
    isCommentValid(c.body, c.user.login, mergeRegex, owners, pr)
  );
  if (hasMergeCommand) {
    core.info(`Found merge comment from ${hasMergeCommand.user.login}`);
  }

  const { data: reviewComments } = await octokit.pulls.listReviews({
    ...repoDeeets,
    pull_number: pr.number,
  });
  const hasMergeCommandReview = reviewComments.find((c) =>
    isCommentValid(c.body, c.user.login, mergeRegex, owners, pr)
  );
  if (hasMergeCommandReview) {
    core.info(`Found merge review from ${hasMergeCommandReview.user.login}`);
    hasMergeCommand = true;
  }
  return hasMergeCommand;
}

async function isApproved(
  octokit,
  repoDeeets,
  pr,
  codeowners,
  owners,
  changedFiles
) {
  let changedFilesNotApproved = changedFiles;

  const approvers = await getApprovers(octokit, repoDeeets, pr, owners);
  if (approvers.length === 0) {
    core.info(
      `Missing approvals for PR. Potential owners: ${formatArray(owners)}`
    );
    return false;
  }

  approvers.forEach((approver) => {
    changedFilesNotApproved = getFilesNotOwnedByCodeOwner(
      "@" + approver,
      changedFilesNotApproved,
      codeowners
    );
  });
  // check files PR owner can merge.
  changedFilesNotApproved = getFilesNotOwnedByCodeOwner(
    "@" + pr.user.login,
    changedFilesNotApproved,
    codeowners
  );

  let missingOwners = getCodeOwners(changedFilesNotApproved, codeowners);
  if (missingOwners.length > 0 && changedFilesNotApproved.length > 0) {
    core.info(
      `Missing files to be approved: ${changedFilesNotApproved}. Potential owners: ${formatArray(
        missingOwners
      )}`
    );
    return false;
  }
  if (changedFilesNotApproved.length > 0 && missingOwners.length === 0) {
    core.info(
      `Files without explicit ownership: ${changedFilesNotApproved}. Continuing merge since we assume this is okay!`
    );
  }

  return approvers;
}

function getPayloadBody() {
  const body = context.payload.comment
    ? context.payload.comment.body
    : context.payload.review.body;
  if (body == null) {
    throw new Error(`No body found, ${JSON.stringify(context)}`);
  }
  return body;
}

// Effectively the main function
async function run() {
  // Setup
  const codeowners = new Codeowners(core.getInput("cwd") || process.cwd());
  const octokit = getOctokit(process.env.GITHUB_TOKEN);
  let pr = context.payload.pull_request;
  const repoDeets = { owner: context.repo.owner, repo: context.repo.repo };
  if (context.payload.issue){
    try {
      ({ data: pr } = await octokit.pulls.get({
        ...repoDeets,
        pull_number: context.payload.issue.number,
      }));
    } catch (error) {
      core.error(error);
      core.info(
        "Error trying to find pull request. Could be invoke from an issue instead. Exiting safely"
      );
      return;
    }
  }

  const changedFiles = await getChangedFiles(octokit, repoDeets, pr.number);
  let labelConfigs = [];
  core.info(`Changed files: ${formatArray(changedFiles)}`);
  const owners = await getCodeOwners(changedFiles, codeowners);
  let commentMessage = "";
  if (context.eventName === "pull_request_target") {
    if (await hasPRWelcomeMessage(octokit, repoDeets, pr.number)) {
      core.info(`PR already welcomed`);
    } else {
      let message = "";
      if (core.getInput("assign_reviewer") === "true") {
        const assignee = await assignReviewer(octokit, owners, repoDeets, pr);
        core.info(`Assigned reviewer: ${assignee}. Sending welcome message!`);
        if (assignee) {
          message = `${ownersWillReviewMessage} Assigned reviewer: ${assignee}`;
        } else {
          message = `${ownersWillReviewMessage} No automatic reviewer could be found.`;
        }
      } else {
        core.info("Skipping reviewer assignation");
        message = ownersWillReviewMessage;
      }

      await welcomeMessage(octokit, repoDeets, pr.number, message);
    }
  } else {
    const body = getPayloadBody();
    const sender = context.payload.sender.login;
    const isApprovalComment = isCommentValid(
      body,
      sender,
      lgtmRegex,
      owners,
      pr,
      context.payload.state === "APPROVED"
    );
    const isMergeComment = isCommentValid(body, sender, mergeRegex, owners, pr);
    if (isApprovalComment && isMergeComment) {
      commentMessage = `Approval and merge request received from @${sender}! :white_check_mark:`;
    } else if (isApprovalComment) {
      commentMessage = `Approval received from @${sender}! :white_check_mark:`;
    } else if (isMergeComment) {
      commentMessage = `Merge request received from @${sender}! :white_check_mark:`;
    }
  }
  if (owners.length === 0) {
    core.info(
      "No owners for changes found. No automatic merge is possible. Consider adding root owners!"
    );
    // Wait a few secons to make sure first comment is published.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await welcomeMessage(
      octokit,
      repoDeets,
      pr.number,
      `No owners for changes found. No automatic merge is possible.`
    );
    process.exit(0);
  }

  const approverOwners = owners.filter((o) => o !== "@" + pr.user.login);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  if (approverOwners.length === 0) {
    core.info(
      "Seems PR user is only owner. Will accept anyone to merge or approve."
    );
    await welcomeMessage(
      octokit,
      repoDeets,
      pr.number,
      `Thanks for the PR! :rocket:

Seems you are only owner for changes on this PR. Any user can use \`/merge\` or \`/lgtm\` to merge or approve.`
    );
  } else {
    await welcomeMessage(
      octokit,
      repoDeets,
      pr.number,
      ownersWillReviewMessage
    );
  }
  const approved = await isApproved(
    octokit,
    repoDeets,
    pr,
    codeowners,
    approverOwners,
    changedFiles
  );
  if (!approved) {
    labelConfigs.push(needsLgtmLabel);
    core.setFailed(`PR cannot be merged`);
    await setLabels(octokit, repoDeets, labelConfigs, pr.number);
    await sendCommentUpdate(
      octokit,
      repoDeets,
      pr.number,
      commentMessage,
      "PR is missing approvals for some files still."
    );
    process.exit(1);
  }
  labelConfigs.push(lgtmLabel);
  if (!(await hasMergeCommand(octokit, repoDeets, pr, approverOwners))) {
    labelConfigs.push(needsMergeLabel);
    core.info(
      `Missing /merge command by an owner: ${formatArray(approverOwners)}`
    );
    await sendCommentUpdate(
      octokit,
      repoDeets,
      pr.number,
      commentMessage,
      "PR is approved. Missing merge command to auto-merge PR!"
    );
    await setLabels(octokit, repoDeets, labelConfigs, pr.number);
    process.exit(1);
  }
  labelConfigs.push(mergeReadyLabel);
  await setLabels(octokit, repoDeets, labelConfigs, pr.number);
  if (!(await isCheckSuiteGreen(octokit, repoDeets, pr))) {
    core.info("Check suite not green");
    await sendCommentUpdate(
      octokit,
      repoDeets,
      pr.number,
      commentMessage,
      "PR will be auto-merged once Test suite is green!"
    );
    process.exit(1);
  }

  // Merge
  core.info(`Merging PR`);
  const {
    head: { sha }
  } = pr;
  try {
    await octokit.pulls.merge({
      ...repoDeets,
      pull_number: pr.number,
      sha: sha,
      // @ts-ignore
      merge_method: core.getInput("merge_method") || "squash",
    });
    await octokit.issues.createComment({
      ...repoDeets,
      issue_number: pr.number,
      body: `Merged with approvals from ${formatArray(
        Array.from(new Set(approved))
      )} - thanks for the contribution! :tada:`,
    });
  } catch (error) {
    for (const changedFile of changedFiles) {
      if (changedFile.includes(".github/workflows")) {
        core.info(
          `Automerge is not available for PRs modifying GitHub Actions. See https://github.com/casassg/auto-merge-bot/issues/1`
        );
        labelConfigs.push(needsManualMergeLabel);
        await setLabels(octokit, repoDeets, labelConfigs, pr.number);
        // process.exit(0);
      }
    }
    core.info(`Merging (or commenting) failed:`);
    core.error(error);
    core.error(error.message);
    core.setFailed("Failed to merge");
    process.exit(1);
  }
}

// @ts-ignore
if (!module.parent) {
  try {
    run();
  } catch (error) {
    core.setFailed(error.message);
    throw error;
  }
}

// Bail correctly
process.on("uncaughtException", function (err) {
  core.setFailed(err.message);
  console.error(new Date().toUTCString() + " uncaughtException:", err.message);
  console.error(err.stack);
  process.exit(1);
});

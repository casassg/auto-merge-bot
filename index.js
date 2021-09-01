// @ts-check

const { context, getOctokit } = require("@actions/github");
const core = require("@actions/core");
const Codeowners = require("codeowners");
const { readFileSync } = require("fs");
const ourSignature = "<!-- Message About Merging -->";
const lgtmRegex = /\/lgtm/i;
const mergeRegex = /\/merge/i;

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

function getCodeOwnersAndLabels(changedFiles, codeowners) {
  const owners = new Set();
  const labels = new Set();

  for (const file of changedFiles) {
    const relative = file.startsWith("/") ? file.slice(1) : file;
    const fileOwners = codeowners.getOwner(relative);
    fileOwners.forEach((o) => {
      if (o.startsWith("@")) owners.add(o);
      if (o.startsWith("[")) labels.add(o.slice(1, o.length - 1));
    });
  }

  return {
    users: Array.from(owners),
    labels: Array.from(labels),
  };
}

async function addLabel(octokit, repoDeets, labelConfig, prNumber) {
  let label = null;
  const existingLabels = await octokit.paginate(
    "GET /repos/:owner/:repo/labels",
    { owner: repoDeets.owner, repo: repoDeets.repo }
  );
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

  await octokit.issues.addLabels({
    ...repoDeets,
    issue_number: prNumber,
    labels: [labelConfig.name],
  });
}

async function isCheckSuiteGreen(octokit, repoDeeets, pr) {
  const checkSuites = await octokit.checks.listSuitesForRef({
    ...repoDeeets,
    ref: `pull/${pr.number}/head`,
  });
  console.log(checkSuites.data);
  const failedSuite = checkSuites.data.check_suites.find(
    (s) =>
      (s.status === "in_progress" ||
        (s.status === "completed" && s.conclusion === "failure")) && !(s.id !== parseInt(process.env.GITHUB_ACTION))
  );
  console.log(process.env.GITHUB_ACTION);
  console.log(process.env.GITHUB_RUN_NUMBER);
  console.log(process.env.GITHUB_RUN_ID);
  if (failedSuite){
    console.log(failedSuite.app);
    core.info(
      `Check suite status: ${failedSuite.status} (${failedSuite.app})`
    );
    return false
  }
  return true
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

async function welcomeMessage(octokit, repoDeets, prNumber, assignee) {
  let message = "";
  if (assignee) {
    message = `Thanks for the PR! :rocket:

Owners will be reviewing this PR. Assigned reviewer: ${assignee}
  
Approve using \`/lgtm\` and mark for automatic merge by using \`/merge\`.
  ${ourSignature}`;
  } else {
    message = `Thanks for the PR! :rocket:

Owners will be reviewing this PR. No automatic reviewer could be found.
  
Approve using \`/lgtm\` and mark for automatic merge by using \`/merge\`.
  ${ourSignature}`;
  }

  octokit.issues.createComment({
    ...repoDeets,
    issue_number: prNumber,
    body: message,
  });
}

async function hasPRWelcomeMessage(octokit, repoDeeets, prNumber) {
  const comments = await octokit.issues.listComments({
    ...repoDeeets,
    issue_number: prNumber,
  });
  const hasMessage = comments.data.find((c) => c.body.includes(ourSignature));
  return hasMessage;
}

async function getApprovers(octokit, repoDeets, pr) {
  const { data: comments } = await octokit.issues.listComments({
    ...repoDeets,
    issue_number: pr.number,
  });
  let users = [];
  comments.forEach((comment) => {
    if (
      comment.body.match(lgtmRegex) &&
      comment.user.login !== pr.user.login &&
      !comment.body.includes(ourSignature)
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
      (comment.state === "APPROVED" || comment.body.match(lgtmRegex)) &&
      comment.user.login !== pr.user.login &&
      !comment.body.includes(ourSignature)
    )
      core.info(`Found lgtm comment from ${comment.user.login}`);
    users.push(comment.user.login);
  });
  return users;
}

async function hasMergeCommand(octokit, repoDeeets, pr, owners) {
  const comments = await octokit.issues.listComments({
    ...repoDeeets,
    issue_number: pr.number,
  });
  let hasMergeCommand = comments.data.find(
    (c) =>
      c.body.match(mergeRegex) &&
      c.user.login !== pr.user.login &&
      owners.includes(c.user.login)
  );

  const { data: reviewComments } = await octokit.pulls.listReviews({
    ...repoDeeets,
    pull_number: pr.number,
  });
  let hasMergeCommandReview = reviewComments.find(
    (c) =>
      c.body.match(mergeRegex) &&
      c.user.login !== pr.user.login &&
      c.user.login in owners
  );
  if (hasMergeCommandReview) {
    hasMergeCommand = true;
  }
  return hasMergeCommand;
}

async function canBeMerged(
  octokit,
  repoDeeets,
  pr,
  codeowners,
  owners,
  changedFiles
) {
  let changedFilesNotApproved = changedFiles;
  if (!(await isCheckSuiteGreen(octokit, repoDeeets, pr))) {
    core.info("Check suite not green");
    return false;
  }
  if (!(await hasMergeCommand(octokit, repoDeeets, pr, owners))) {
    core.info("Missing /merge command by an owner");
    return false;
  }
  const approvers = await getApprovers(octokit, repoDeeets, pr);
  if (approvers.length < 1) {
    core.info("Missing approvals for PR");
    return false;
  }

  approvers.forEach((approver) => {
    changedFilesNotApproved = getFilesNotOwnedByCodeOwner(
      "@" + approver,
      changedFilesNotApproved,
      codeowners
    );
  });
  if (changedFilesNotApproved.length > 0) {
    core.info(`Missing files to be approved: ${changedFilesNotApproved}`);
    return false;
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
  const pr = context.payload.pull_request || context.payload.issue;
  const repoDeets = { owner: context.repo.owner, repo: context.repo.repo };
  const changedFiles = await getChangedFiles(octokit, repoDeets, pr.number);

  const { users: owners, labels: labels } = await getCodeOwnersAndLabels(
    changedFiles,
    codeowners
  );
  if (context.eventName === "pull_request_target") {
    if (await hasPRWelcomeMessage(octokit, repoDeets, pr.number)) {
      core.info(`PR already welcomed`);
    } else {
      const assignee = await assignReviewer(octokit, owners, repoDeets, pr);
      core.info(`Assigned reviewer: ${assignee}. Sending welcome message!`);
      await welcomeMessage(octokit, repoDeets, pr.number, assignee);
    }
  } else {
    const body = getPayloadBody();
    const sender = context.payload.sender.login;

    if (
      body.match(lgtmRegex) &&
      owners.includes(sender) &&
      sender !== pr.user.login
    ) {
      await octokit.issues.createComment({
        ...repoDeets,
        issue_number: pr.number,
        body: `Approval received from @${sender}! :white_check_mark:`,
      });
    }

    if (
      body.match(mergeRegex) &&
      owners.includes(sender) &&
      sender !== pr.user.login
    ) {
      await octokit.issues.createComment({
        ...repoDeets,
        issue_number: pr.number,
        body: `Merge request from @${sender} received. PR will be automatically merged once it has all necessary approvals! :white_check_mark:`,
      });
    }
  }
  for (const label of labels) {
    const labelConfig = {
      name: label,
      color: Math.random().toString(16).slice(2, 8),
    };
    core.info(`Adding label ${label}`);
    await addLabel(octokit, repoDeets, labelConfig, pr.number);
  }
  const approved = await canBeMerged(
    octokit,
    repoDeets,
    pr,
    codeowners,
    owners,
    changedFiles
  );
  if (!approved) {
    core.setFailed(`PR cannot be merged`);
    process.exit(1);
  }

  // Merge
  core.info(`Merging PR`);
  try {
    await octokit.pulls.merge({
      ...repoDeets,
      pull_number: pr.number,
      // @ts-ignore
      merge_method: core.getInput("merge_method") || "squash",
    });
    await octokit.issues.createComment({
      ...repoDeets,
      issue_number: pr.number,
      body: `Merged with approvals from ${Intl.ListFormat().format(
        owners
      )} - thanks for the contribution! :tada:`,
    });
  } catch (error) {
    core.info(`Merging (or commenting) failed:`);
    core.error(error);
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

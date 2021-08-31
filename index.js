// @ts-check

const { context, getOctokit } = require('@actions/github')
const core = require('@actions/core');
const Codeowners = require('codeowners');
const {readFileSync} = require("fs");

// Effectively the main function
async function run() {
  core.info("Running version 1.6.0")
  let returnMessage = "";
  // Tell folks they can merge
  if (context.eventName === "pull_request_target") {
    await commentOnMergablePRs()
    await new Actor().mergeIfHasAccess();
  }

  // Merge if they say they have access
  if (context.eventName === "issue_comment" || context.eventName === "pull_request_review") {
    const bodyLower = getPayloadBody().toLowerCase();
    if (bodyLower.includes("/lgtm")) {
      new Actor().mergeIfHasAccess();
    } else if (bodyLower.includes("@github-actions close")) {
      new Actor().closePROrIssueIfInCodeowners();
    } else {
      console.log("Doing nothing because the body does not include a command")
    }
    if (returnMessage) {
      console.log(returnMessage)
      core.setFailed(returnMessage);
    }
  }
}

async function commentOnMergablePRs() {
  if (context.eventName !== "pull_request_target") {
    throw new Error("This function can only run when the workflow specifies `pull_request_target` in the `on:`.")
  }

  // Setup
  const cwd = core.getInput('cwd') || process.cwd()
  const octokit = getOctokit(process.env.GITHUB_TOKEN)
  const pr = context.payload.pull_request
  const thisRepo = { owner: context.repo.owner, repo: context.repo.repo }

  core.info(`\nLooking at PR: '${pr.title}' to see if the changed files all fit inside one set of code-owners to make a comment`)

  const co = new Codeowners(cwd);
  core.info(`Code-owners file found at: ${co.codeownersFilePath}`)

  const changedFiles = await getPRChangedFiles(octokit, thisRepo, pr.number)
  core.info(`Changed files: \n - ${changedFiles.join("\n - ")}`)

  const codeowners = findCodeOwnersForChangedFiles(changedFiles, cwd)
  core.info(`Code-owners: \n - ${codeowners.users.join("\n - ")}`)
  core.info(`Labels: \n - ${codeowners.labels.join("\n - ")}`)

  if (!codeowners.users.length) {
    console.log("This PR does not have any code-owners")
    process.exit(0)
  }

  const ourSignature = "<!-- Message About Merging -->"
  const comments = await octokit.issues.listComments({ ...thisRepo, issue_number: pr.number })
  const existingComment = comments.data.find(c => c.body.includes(ourSignature))
  if (existingComment) {
    console.log("There is an existing comment")
    process.exit(0)
  }


  // Get a list of all open pull requests to current repository with base branch set as main
  const openPullRequests = await octokit.pulls.list({
    owner: thisRepo.owner,
    repo: thisRepo.repo,
    state: "open",
    base: 'main'
  })

  // Get a dictionary of users assigned to PRs as key and times assigned as value
  let assignedToPRs = {}
  for (const pr of openPullRequests.data) {
    if (pr.assignees.length) {
      for (const assignee of pr.assignees) {
        assignedToPRs[assignee.login] = assignedToPRs[assignee.login] || 0
        assignedToPRs[assignee.login] += 1
      }
    }
  }

  // Shuffle codeowners list to randomise who gets the assignation.
  // This is to prevent people from getting the same assignation every time.
  codeowners.users.sort(() => Math.random() - 0.5)

  // Randomly get a user to assign to this PR with the minimum number of PRs assigned to them
  let assignee = null
  let minPRs = Number.MAX_SAFE_INTEGER
  codeowners.users.forEach(user => {
    if ((assignedToPRs[user] || 0) < minPRs) {
      assignee = user
      minPRs = assignedToPRs[user]
    }
  })
  
  core.info(`Arbitrary choosen ${assignee} as assigned reviewer! PR assigned: ${minPRs}`)
  await octokit.issues.addAssignees({ ...thisRepo, issue_number: pr.number, assignees: [assignee]})


  const message = `Thanks for the PR! :rocket:

  Owners will be reviewing this PR. Assigned reviewer: ${assignee}

  Approve using \`/lgtm\` to merge.
${ourSignature}`

  await octokit.issues.createComment({ ...thisRepo, issue_number: pr.number, body: message });

  // Add labels
  for (const label of codeowners.labels) {
    const labelConfig = { name: label, color: Math.random().toString(16).slice(2, 8) }
    await createOrAddLabel(octokit, { ...thisRepo, id: pr.number }, labelConfig)
  }
}

function getPayloadBody() {
  const body = context.payload.comment ? context.payload.comment.body : context.payload.review.body
  if (body == null) {
    throw new Error(`No body found, ${JSON.stringify(context)}`)
  }
  return body;
}

class Actor {
  constructor() {
    this.cwd = core.getInput('cwd') || process.cwd()
    this.octokit = getOctokit(process.env.GITHUB_TOKEN)
    this.thisRepo = { owner: context.repo.owner, repo: context.repo.repo }
    this.issue = context.payload.issue || context.payload.pull_request
    /** @type {string} - GitHub login */
    this.sender = context.payload.sender.login
  }

  async getTargetPRIfHasAccess() {
    const { octokit, thisRepo, sender, issue, cwd } = this;
    core.info(`\n\nLooking at the ${context.eventName} from ${sender} in '${issue.title}' to see if we can proceed`)

    const changedFiles = await getPRChangedFiles(octokit, thisRepo, issue.number)
    core.info(`Changed files: \n - ${changedFiles.join("\n - ")}`)
    let changedNotApprovedFiles = changedFiles;

    // const comments = await octokit.issues.listComments({ ...thisRepo, issue_number: issue.number })
    // Get a list of all comments that contain lgtm in the body for a GitHub issue with issue.number with pagination



    const { data: comments } = await octokit.issues.listComments({ ...thisRepo, issue_number: issue.number })
    comments.forEach(comment => {
      if (comment.body.includes("lgtm")) {
        changedNotApprovedFiles = getFilesNotOwnedByCodeOwner("@" + comment.user.login, changedNotApprovedFiles, cwd)
      }
    });
    
    changedNotApprovedFiles = getFilesNotOwnedByCodeOwner("@" + issue.user.login, changedNotApprovedFiles, cwd)
    changedNotApprovedFiles = getFilesNotOwnedByCodeOwner("@" + sender, changedNotApprovedFiles, cwd)
    if (changedNotApprovedFiles.length !== 0) {
      console.log(`Not approved changes: \n - ${changedNotApprovedFiles.join("\n - ")}\n`)
      listFilesWithOwners(changedFiles, cwd)
      let body = `Missing approvals for:\n\n${getFilesWithOwners(changedNotApprovedFiles)}`
      core.setFailed(body); 
      process.exit(1)
    }

    const prInfo = await octokit.pulls.get({ ...thisRepo, pull_number: issue.number })
    return prInfo
  }

  async mergeIfHasAccess() {
    const prInfo = await this.getTargetPRIfHasAccess()
    if (!prInfo) {
      core.setFailed(`Missing approvals for PR to be merged`); 
      process.exit(1)
    }

    const { octokit, thisRepo, issue, sender } = this;

    // Don't try merge unmergable stuff
    if (!prInfo.data.mergeable) {
      core.setFailed(`Sorry, this PR has merge conflicts. They'll need to be fixed before this can be merged.`);
      process.exit(1)
    }

    // Don't merge red PRs
    const statusInfo = await octokit.repos.listCommitStatusesForRef({ ...thisRepo, ref: prInfo.data.head.sha })
    const failedStatus = statusInfo.data
      // Check only the most recent for a set of duplicated statuses
      .filter(
        (thing, index, self) =>
          index === self.findIndex((t) => t.target_url === thing.target_url)
      )
      .find(s => s.state !== "success")

    if (failedStatus) {
      core.setFailed(`Sorry, this PR could not be merged because it wasn't green. Blocked by [${failedStatus.context}](${failedStatus.target_url}): '${failedStatus.description}'.`)
      process.exit(1)
    }

    core.info(`Creating comments and merging`)
    try {
      // @ts-ignore
      await octokit.pulls.merge({ ...thisRepo, pull_number: issue.number, merge_method: core.getInput('merge_method') || 'squash' });
      await octokit.issues.createComment({ ...thisRepo, issue_number: issue.number, body: `Merged - thanks for the contribution! :tada:` });
    } catch (error) {
      core.info(`Merging (or commenting) failed:`)
      core.error(error)
      core.setFailed("Failed to merge")
      process.exit(1)
      
    }
  }

  async closePROrIssueIfInCodeowners() { 
    // Because closing a PR/issue does not mutate the repo, we can use a weaker
    // authentication method: basically is the person in the codeowners? Then they can close
    // an issue or PR. 
    if (!githubLoginIsInCodeowners(this.sender, this.cwd)) return

    const { octokit, thisRepo, issue, sender } = this;

    core.info(`Creating comments and closing`)
    await octokit.issues.update({ ...thisRepo, issue_number: issue.number, state: "closed" });
    await octokit.issues.createComment({ ...thisRepo, issue_number: issue.number, body: `Closing because @${sender} is one of the code-owners of this repository.` });
  }
}

/**
 *
 * @param {string} owner
 * @param {string[]} files
 * @param {string} cwd
 */
function getFilesNotOwnedByCodeOwner(owner, files, cwd) {
  const filesWhichArentOwned = []
  const codeowners = new Codeowners(cwd);

  for (const file of files) {
    const relative = file.startsWith("/") ? file.slice(1) : file
    let owners = codeowners.getOwner(relative);
    if (!owners.includes(owner)) {
      filesWhichArentOwned.push(file)
    }
  }

  return filesWhichArentOwned
}


/**
 * This is a reasonable security measure for proving an account is specified in the codeowners
 * but _SHOULD NOT_ be used for authentication for something which mutates the repo,
 * 
 * @param {string} login
 * @param {string} cwd
 */
 function githubLoginIsInCodeowners(login, cwd) {
  const codeowners = new Codeowners(cwd);
  const contents = readFileSync(codeowners.codeownersFilePath, "utf8").toLowerCase()

  return contents.includes("@" + login.toLowerCase() + " ") || contents.includes("@" + login.toLowerCase() + "\n")
}


/**
 *
 * @param {string[]} files
 * @param {string} cwd
 */
function listFilesWithOwners(files, cwd) {
  const codeowners = new Codeowners(cwd);
  console.log("\nKnown code-owners for changed files:")
  for (const file of files) {
    const relative = file.startsWith("/") ? file.slice(1) : file
    let owners = codeowners.getOwner(relative);
    console.log(`- ${file} (${new Intl.ListFormat().format(owners)})`)
  }
  console.log("\n> CODEOWNERS file:")
  console.log(readFileSync(codeowners.codeownersFilePath, "utf8"))
}

function getFilesWithOwners(files, cwd) {
    let returnStr = ""
    const codeowners = new Codeowners(cwd);
    console.log("\nKnown code-owners for changed files:")
    for (const file of files) {
      const relative = file.startsWith("/") ? file.slice(1) : file
      let owners = codeowners.getOwner(relative).map(o => o.replace("@", ""));
      returnStr += `- ${file} (${new Intl.ListFormat().format(owners)})\n`
    }
    return returnStr
  }


function findCodeOwnersForChangedFiles(changedFiles, cwd)  {
  const owners = new Set()
  const labels = new Set()
  const codeowners = new Codeowners(cwd);

  for (const file of changedFiles) {
    const relative = file.startsWith("/") ? file.slice(1) : file
    const fileOwners = codeowners.getOwner(relative)
    fileOwners.forEach(o => {
      if (o.startsWith("@")) owners.add(o)
      if (o.startsWith("[")) labels.add(o.slice(1, o.length-1))
    })
  }

  return {
    users: Array.from(owners),
    labels: Array.from(labels)
  }
}

async function getPRChangedFiles(octokit, repoDeets, prNumber) {
  // https://developer.github.com/v3/pulls/#list-pull-requests-files
  const options = octokit.pulls.listFiles.endpoint.merge({...repoDeets, pull_number: prNumber });

  /** @type { import("@octokit/types").PullsListFilesResponseData} */
  const files = await octokit.paginate(options)
  const fileStrings = files.map(f => `/${f.filename}`)
  return fileStrings
}

async function createOrAddLabel(octokit, repoDeets, labelConfig) {
  let label = null
    const existingLabels = await octokit.paginate('GET /repos/:owner/:repo/labels', { owner: repoDeets.owner, repo: repoDeets.repo })
    label = existingLabels.find(l => l.name == labelConfig.name)

  // Create the label if it doesn't exist yet
  if (!label) {
    await octokit.issues.createLabel({
      owner: repoDeets.owner,
      repo: repoDeets.repo,
      name: labelConfig.name,
      color: labelConfig.color,
      description: labelConfig.description,
    })
  }

  await octokit.issues.addLabels({
    owner: repoDeets.owner,
    repo: repoDeets.repo,
    issue_number: repoDeets.id,
    labels: [labelConfig.name],
  })
}

// For tests
module.exports = {
  getFilesNotOwnedByCodeOwner,
  findCodeOwnersForChangedFiles,
  githubLoginIsInCodeowners
}

// @ts-ignore
if (!module.parent) {
  try {
    run()
  } catch (error) {
    core.setFailed(error.message)
    throw error
  }
}

// Bail correctly
process.on('uncaughtException', function (err) {
  core.setFailed(err.message)
  console.error((new Date).toUTCString() + ' uncaughtException:', err.message)
  console.error(err.stack)
  process.exit(1)
})

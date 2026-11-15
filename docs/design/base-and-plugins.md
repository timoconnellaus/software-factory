# The base, and what a plugin adds

## What the base does with no plugins at all
- You have **projects**, and each has **items** on a board.
- A project follows a **workflow**: a list of statuses you name, each with an owner (an agent, a person, or nobody).
- When an item enters a status owned by an **agent**, the agent runs on one of your machines with that status's brief. When it enters one owned by a **person**, it shows in their inbox.
- Everything that happens to an item is on its **timeline**: moves, comments, runs.
- **Auto** starts work on a schedule.

That alone runs a workflow like *Draft → Review → Done*, where an agent writes, another reviews and you approve. It knows nothing about GitHub, blogs, customers or invoices.

## A workflow is not a plugin
Workflows, statuses and owners are part of the base. You set them up per org. Later, a workflow could be saved as a template to start another project from.

## Gateways: how the app reaches outside systems
A **gateway** is your org's connection to one outside system, such as Gmail, GitHub or Slack. You set it up once. Plugins and agents use it by name, so two plugins can both use Gmail without either carrying its own access.

## What a plugin is
A plugin is **something you ask an agent for that the base can't do**. You say it in plain words, the agent builds it, and it is live.

## Four examples

**1. "When an item reaches Published, post it to our blog and put the link on the item."**
The base can move the item to Published. It can't post to a blog. The plugin adds that step, using the blog's gateway, and a card on the timeline with the link.

**2. "Items in Customer feedback need a Customer field shown on the board, and a new support email should create an item."**
The base has no Customer field and doesn't read email. The plugin adds the field, shows it on the board card, and turns emails into items, using the Gmail gateway.

**3. "For software projects, show the pull request and its checks on the item, and don't let it move to Approve until the checks pass."**
The base doesn't know what a pull request is. The plugin adds the card and the rule, using the GitHub gateway. This is all that "software development" is in the new design: one plugin among others.

**4. "Give me a page that shows what each agent cost this week."**
The base records the cost of every run but has no such page. The plugin adds the page.

## The line between them
If every kind of work needs it (items, statuses, owners, agents running, the timeline, the inbox), it is the base. If only some kinds of work need it, it is a plugin. If it is a connection to an outside system, it is a gateway.

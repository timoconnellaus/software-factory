# Mobile app v1: Android, Flutter

The phone app for the software factory. First version is Android, built with Flutter, with iOS from the same code later.

## Starting position
- **Same model as the desktop.** Orgs have projects; a project runs on a workflow; one object runs through the app, the work item.
- **Same server.** It calls the factory's operations through the client door, as the desktop app does.
- **The phone runs no agents,** so it is the safest device to approve from.

## Decided
- **Scope.** Nearly everything except factory setup: decide gates, answer the planner, capture, see what is running, message or stop an agent, release work, chat, and manage the backlog. Editing workflows, agents, skills and policy by hand stays on the desktop.
- **Approvals.** A fingerprint for every plan approval and merge. The key lives in the phone's secure hardware. Ordinary planning answers are one tap.
- **Policy changes can be approved on the phone too.** Chat can draft a policy or workflow change, and you approve it on the phone rather than going to the desktop.
- **Home.** It opens on the Inbox, showing what waits on you across all orgs, with a chip to filter to one org.
- **Navigation.** Bottom tabs: Inbox, Work, Chat and You, with a capture button in the middle.
- **Planning.** Fully on the phone, as four tabs on the work item: Questions, Plan, Chat and Mockups. Tap a line of the plan to edit just that line.
- **Backlog.** Edit title, notes and priority; drag to reorder; move between Backlog and Ready; start planning; release; see the factory's triage notes and size. Linking items and bulk actions stay on the desktop.
- **Chat.** Answers questions, adds to the backlog, releases work, drafts policy and workflow changes, takes voice input, and can be started from a work item. It never approves or merges by itself.
- **Capture.** Type, dictate, share from another app, or attach a photo. Everything lands in a project's Backlog and nothing starts.
- **Notifications.** An approval is waiting, the planner asked a question, a run failed or an incident opened, an agent is stuck.
- **Running agents.** Watch the activity, send a message, stop or pause. No typing into a terminal.
- **Install.** A signed APK you download, with in-app updates.
- **Push.** Google's push service (Firebase Cloud Messaging). It needs a free Firebase project under the owner's Google account. A notification carries an item number and a type, never content.
- **Sign-in.** Either scan a QR code shown by the desktop app or website, or sign in with GitHub in the phone's browser. The phone is registered as a device with its own key and can be revoked.
- **Approval notifications.** Tapping one opens the review screen, and the approval happens there. A planner question can be answered with its recommended answer from the notification.
- **Offline.** Read what was last loaded, and capture ideas that send when back online. Approvals, answers and messages to agents need a connection and are disabled with a note.
- **Policy approvals.** A fingerprint, after a screen that shows the change as before and after and marks anything that loosens a gate.
- **Backlog actions.** Tapping an item expands it in place with Open, Plan it, Ready and Release.

## Assumptions the owner did not overturn
- The code lives in the same repository, in `apps/mobile`.
- It follows the desktop's look, in light and dark, following the phone's setting.
- English only, phones only (no tablet layout) in v1.
- Android 10 or newer.

## Screens designed (in `.kim/mockups/`)
Home with bottom tabs, planning questions, editing a line of the plan, the merge gate, a running work item, capture, and the backlog. A one-screen home was considered and rejected.

## Not designed yet
Chat, the Mockups tab, the policy approval screen, sign-in and QR pairing, the You tab, notifications and their settings.

## Next
1. Write the spec for the app and for what the server needs (push registration, phone devices and their keys, QR pairing).
2. The owner creates the Firebase project.
3. Build in slices: sign-in and the Inbox with the merge gate first.

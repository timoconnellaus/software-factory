# Phone app design

The first version of the phone app: Android first, built with Flutter. One static HTML file per screen, drawn at 390 × 844. Open a file in a browser at that width. They are pictures of the target, not code to copy.

The decisions behind them are in [`.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md`](../../../.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md). The look follows the desktop design in [`../factory-ui/README.md`](../factory-ui/README.md): the same colours, chips and type, in light and dark.

## Rules that hold on every screen
- Bottom tabs: Inbox, Work, Chat, You, with the capture button in the middle. Screens opened from a list have a back arrow and no tabs.
- An amber outline means the item needs you.
- A plan approval, a merge and a policy change each ask for a fingerprint, on a sheet that names what is being approved. Ordinary answers are one tap.
- Offline: reading works from the last load and capture queues. Approvals, answers and messages to agents are disabled with a note.
- The data shown is illustrative.


## Getting in
| File | Screen | What it must do |
| --- | --- | --- |
| [SignIn.html](SignIn.html) | Sign in | Two ways in: scan a code, or GitHub in the browser. |
| [Pair.html](Pair.html) | Pair by QR code | The camera, with where to find the code and a typed-code fallback. |
| [PairConfirm.html](PairConfirm.html) | Confirm this phone | Names the phone and turns on fingerprint approval and notifications. |

## Inbox and decisions
| File | Screen | What it must do |
| --- | --- | --- |
| [Inbox.html](Inbox.html) | Inbox | Home. What waits on you across all orgs, then what is running. Org chips filter. Merge and Send back act from the card. |
| [InboxEmpty.html](InboxEmpty.html) | Inbox: all clear, offline | Nothing waiting, and the offline banner with the time of the last load and queued ideas. |
| [InboxQuestion.html](InboxQuestion.html) | A question from a build | A question raised by a run, with the recommended answer picked and why it was asked. |
| [MergeGate.html](MergeGate.html) | Merge gate | The review packet: verdict, checks, criteria proven or not, tests intact, the diff, and the decision bar. |
| [Diff.html](Diff.html) | Reading the diff | One file at a time, with file chips and previous/next. |
| [SendBack.html](SendBack.html) | Send back with a note | A note is required; it goes to the same build session. Voice input. |
| [Fingerprint.html](Fingerprint.html) | Approving with a fingerprint | The system fingerprint sheet, naming exactly what is approved and the commit. |
| [PolicyApprove.html](PolicyApprove.html) | Approving a policy change | A policy or workflow change drafted in chat: before and after, loosening marked, what cannot change, the version it binds to. |
| [LockScreen.html](LockScreen.html) | Notifications on the lock screen | The four notification kinds. Approvals only open the review; a planner question can be accepted from the notification; with details off only the number and kind show. |

## Planning
| File | Screen | What it must do |
| --- | --- | --- |
| [PlanQuestions.html](PlanQuestions.html) | Planning: questions | Planning tab 1. Answered rows, the open question with options and the reason, Skip, and the approval bar. |
| [PlanEdit.html](PlanEdit.html) | Planning: editing a line | Planning tab 2. Tap a line to edit just that line; Save and Cancel sit under it. |
| [PlanChat.html](PlanChat.html) | Planning: chat | Planning tab 3. Chat with the planner, read receipts, a link to mockups, the planner's current step with Stop, voice input. |
| [PlanMockups.html](PlanMockups.html) | Planning: comparing mockups | Planning tab 4. Options as swipeable cards for one question; choose, open full screen, comment, or ask for another. |
| [PlanApprove.html](PlanApprove.html) | Plan ready to approve | The finished plan with its split, the summary line and Approve, which asks for a fingerprint. |

## Work
| File | Screen | What it must do |
| --- | --- | --- |
| [WorkBacklog.html](WorkBacklog.html) | Work: backlog | The Work tab on Backlog. Drag to reorder; tapping an item expands it with Open, Plan it, Ready and Release. |
| [ItemBacklog.html](ItemBacklog.html) | A backlog item | A backlog item: notes and attachments, project and priority, and the factory's triage notes. |
| [WorkReady.html](WorkReady.html) | Work: ready to release | Ready items with capacity at the top; Release is disabled with the reason when an item waits for another. |
| [WorkRunning.html](WorkRunning.html) | Work: running | Running work grouped by stage, with what needs you outlined. |
| [ItemRunning.html](ItemRunning.html) | Work item, running | A running item as an activity stream: hand-offs, the plan with its tasks, the live run, and a composer with Pause and Stop. |

## Capture and chat
| File | Screen | What it must do |
| --- | --- | --- |
| [Capture.html](Capture.html) | Capture | The capture sheet from the middle button: title, notes, attachment, project, priority, voice and camera. |
| [CaptureVoice.html](CaptureVoice.html) | Capture by voice | Dictation with a live transcript. |
| [CaptureShare.html](CaptureShare.html) | Shared from another app | What appears when something is shared to the app from another app. |
| [ChatList.html](ChatList.html) | Chat | Chats, newest first, each with its project. |
| [ChatThread.html](ChatThread.html) | A chat | A chat. Answers carry cards for the items they mention and for what the chat did (added to backlog, sent to an agent, drafted a change). |

## You
| File | Screen | What it must do |
| --- | --- | --- |
| [You.html](You.html) | You | Account, orgs with what waits in each, runners, settings, version and update. |
| [Notifications.html](Notifications.html) | Notification settings | Per-kind switches in three groups, quiet hours, and whether details show on the lock screen. |

## Not drawn
Dark mode for each screen, the full-screen mockup viewer, the Devices list, the typed pairing code, search, and error states beyond offline. Build these from the same parts.

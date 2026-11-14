# Soft Yes in Claude: the demo

Checked 14.11 at 14:10 and again at 15:30 EET on claude.ai in Chrome, on your Claude account. The connector "Soft Yes" is already added and connected there.

## Before you walk over

1. Laptop, browser, https://claude.ai/new.
2. Tap **+** under the message box, then Connectors. Soft Yes should be on.
3. Saves a tap in front of people: Customize > Connectors > Soft Yes, set the tools to "Always allow".

## Type this

> Tesi and Innovestor said they're in once we have a lead. Use Soft Yes to find who could lead our Series A.

## What appears

1. Claude asks "Claude wants to use Find who could lead the round from Soft Yes". Press **Allow once**.
2. The card draws in the chat in about 10 s. Tesi and Innovestor on the left, the rounds they joined in the middle, who led them on the right. Each "led" gets a tick when the page Cala cites says the same. Wrong ones are struck through.
3. The numbers row: 406 facts from Cala, 77 pages read, 45 "led" claims hold, 2 do not, 0 facts from a language model.
4. Lead 1 is **Lifeline Ventures**, "Leading now". Under it the sentence from thenextweb.com: "The round comprises equity led by Lifeline Ventures, with participation from byFounders, Tesi, and Varma". Next to it: "Tesi opens the door".
5. Claude writes its own short answer under the card.

## 60 seconds

- **0 to 10 s.** "Every founder hears 'we're in once you have a lead'. Two investors said that to us." Paste the message, press Allow once.
- **10 to 30 s**, while it draws. "This is your graph. The rounds Tesi and Innovestor joined, and who led them. Every 'led' is checked against the page you cite for it."
- **30 to 45 s**, point at Lifeline. "Start with Lifeline. That's the sentence from the page. Tesi was in that round, so Tesi opens the door."
- **45 to 60 s**, tap **Draft the ask to Tesi** in the card. The ask opens right there in about a second, with every fact in it and where it is from. "Two of your 'led' flags didn't match the page. They never reach this email. Zero facts come from a language model."

Then ask: "Would a founder use this the week before Slush?"

## Buttons in the card

All checked in real Claude at 15:30. None of them asks for Allow once.

- **Draft the ask to Tesi**: the ask opens inside the card. **Open in Gmail** puts it in a new Gmail message (Claude asks "Open external link" first). **Copy** copies it.
- **Who else opens this door**: the network. Tesi and Innovestor, 25 rounds, 95 other investors.
- **One hop from Lifeline**: walks Cala one round further out, live. 23 rounds, 86 investors.
- **Replay** runs the drawing again. **Expand** makes it full screen.

## If they want more

Type these. Each one is a new Allow once.

- `Draft the intro ask to Tesi about Lifeline Ventures.` Checked in real Claude at 14:45. Claude looks in your Gmail for Tesi's mail, draws the ask, opens the round tracker and saves a Gmail draft. Nothing is sent. About a minute, Allow once three times. The button in the card is faster.
- `Who could lead Cala AI's next round? Use Soft Yes.` Their own company. It starts from Kfund, Lightspeed, Kibo and Masia: 27 leads, Base10 Partners first.
- `Who led Cala AI's rounds, by the page?` Each "led" Cala holds for Cala AI, next to the page's sentence.

The last two work in the stand-in chat (below) but are not run in real Claude yet. If Claude answers in text with no card, add "use Soft Yes".

## Reset

Open a new chat. The same message draws the same card. **Replay** in the card's corner runs the drawing again.

## If Claude lets you down

https://soft-yes.fly.dev/chat is the same card in a plain stand-in chat. No login, no language model. Tap **Tesi and Innovestor said yes**.

The site still works as before: https://soft-yes.fly.dev/r/5c6518e3ff

## Does not work yet

- **Draft the ask in the round tracker card** still sends Claude a message when the card can't write it itself. If you see "Soft Yes wants to send Claude a message", press Decline and type the sentence.
- **The ask from the button has blanks**: [your company] and [what you do]. Typed in the chat, Claude fills them from what it knows about you.
- **Claude adds its own words.** It reads your memory: in the test it asked "Is this round for Helios One or Minttu?", called Emergence "a US growth fund", and wrote the ask for Helios One. The card is the checked part, the text under it is Claude.
- **The soft yes from Gmail.** Saving the ask as a Gmail draft works. Starting with no names and letting Claude find the soft yes in your mail is not tested, and your inbox has no mail from Tesi.
- **Claude phone and desktop apps** are not tested. Use claude.ai in the browser.
- **Text but no card** means the connector is off in that chat: + > Connectors > Soft Yes.

## If the connector is missing

Customize > Connectors > Add custom connector. Name `Soft Yes`, address `https://soft-yes.fly.dev/mcp`, no sign-in. Add, then Connect.

Screenshot of the real thing: `/bulk3/runs/cala/claude-app/claude-walk.png`

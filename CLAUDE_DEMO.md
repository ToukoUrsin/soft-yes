# Soft Yes in Claude: the demo

Checked 14.11 at 20:15 EET on claude.ai in Chrome, on your Claude account. Soft Yes is added there and set to "Always allow", so nothing asks for a click.

## Before you walk over

Laptop, https://claude.ai/new in Chrome (the Claude phone and desktop apps are not tested). Click **+** under the message box, then Connectors. Soft Yes should be on. If it is off, switch it on. Not listed: see the last section.

Open this file on the laptop too, so you can paste. Paste the two messages below once now, each in a new chat. At the table do the same, word for word: a changed wording takes one to three minutes.

## 1. Find investors (show this first)

Paste:

> We're building in artificial intelligence in Europe and raising a pre-seed round. Use Soft Yes to find the investors who fit, and who Cala AI's investors could introduce us to.

Say while it draws:

> "We ask your graph for companies like ours, then read their rounds and what you have on each investor. When your data says a fund led a round, we open the page you cite and check it. Nothing in the card comes from a language model."

The card comes in about 25 s. Point at:

1. The list. **Ovni Capital** and **Contrarian Ventures** led Bleu Robotics's €5M pre-seed this month. The sentence from thesaasnews.com is under it. **Accel** has a way in: 3 rounds with Lightspeed, a Cala AI investor. Click an investor to open it.
2. The numbers: 294 facts from Cala, 15 pages read, 0 from a language model.
3. The dots next to each investor: one for each thing its own record says (your field, leads rounds, pre-seed, active now, round size, near you, a way in). Few dots means Cala has little on that fund.

If they read Claude's text under the card: that is Claude, only the card is checked.

If they ask where it comes from:

- The question at the bottom of the card is in Cala's own query language.
- The companies Cala names: Bleu Robotics, INXM, Faircado, Tolemy Bio.
- **Cala AI's investors**, bottom left: the 7 rounds Kfund, Lightspeed, Kibo and Masia sat in.

## 2. Who could lead (the soft yes)

Paste:

> Tesi and Innovestor said they're in once we have a lead. Use Soft Yes to find who could lead our Series A.

Say:

> "Second example, a company further along. A soft yes is an investor who is in once someone leads. So we look at who led the rounds they joined, and check each 'led' against the page you cite."

1. The card draws in about 10 s. Tesi and Innovestor on the left, the rounds they joined in the middle, who led them on the right. A tick means the page Cala cites says the same. Wrong ones are struck through.
2. The numbers: 407 facts from Cala, 78 pages read, 47 "led" claims hold, 2 do not.
3. Lead 1 is **Emergence Capital**: it led Verda's $189M Series B in September with Tesi in the round. **Lifeline Ventures** is second. Next to each: "Tesi opens the door".
4. Click **Draft the ask to Tesi**. The ask opens in the card. Type `Tundra Power` (made up for the demo) as the company and `power electronics that cut energy losses in data centres` as what you do.

If they ask why a Series B lead is first for a Series A: Emergence also led 4 Series A rounds in Cala, and it is the latest lead Tesi sat next to.

## Buttons in the card

- **Open in Gmail**, inside the ask: puts it in a new Gmail message.
- **Who else opens this door**: the 95 other investors in Tesi and Innovestor's 25 rounds.
- **Replay** draws it again. **Expand** makes it full screen.

## If they want more

All of these answer in seconds:

- `Who could lead Cala AI's next round? Use Soft Yes.` Their own company: 27 leads, Base10 Partners first.
- `Who led Cala AI's rounds? Use Soft Yes to check each one against the page Cala cites.` Each "led" Cala holds for Cala AI, next to the page's sentence.
- `I'm starting an AI lab. Which pre-seed investors could Cala AI's investors introduce me to? Use Soft Yes.` Techstars, Northzone, Base10 Partners first.
- `We build climate tech in the Nordics and raise a seed round. Tesi and Innovestor know us. Use Soft Yes to find investors.` Lifeline Ventures first: it led Verda's Series A with Tesi in the round.

## Reset

Open a new chat. The same message draws the same card.

## If Claude lets you down

Text but no card means Soft Yes is off in that chat: + > Connectors > Soft Yes.

If Claude itself is down, https://soft-yes.fly.dev/chat shows the same card without Claude. No login. Click **Pre-seed investors for AI in Europe**.

## If Soft Yes is missing

Customize > Connectors > Add custom connector. Name `Soft Yes`, address `https://soft-yes.fly.dev/mcp`, no sign-in. Add, then Connect.

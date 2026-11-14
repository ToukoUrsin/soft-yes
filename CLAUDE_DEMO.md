# Soft Yes in Claude: the demo

Checked 14.11 at 20:15 EET on claude.ai in Chrome, on your Claude account. The connector "Soft Yes" is added there and its tools are on "Always allow", so nothing asks for a tap.

## Before you walk over

1. Laptop, browser, https://claude.ai/new.
2. Tap **+** under the message box, then Connectors. Soft Yes should be on.

## 1. Find investors (new, show this first)

Type this:

> We're building in artificial intelligence in Europe and raising a pre-seed round. Use Soft Yes to find the investors who fit, and who Cala AI's investors could introduce us to.

What appears, in about 25 s:

1. The card draws the search. First the question Cala is asked, in Cala's own query language. Then the companies it names (Bleu Robotics, INXM, Faircado, Tolemy Bio). Then the investors in them.
2. A second source at the bottom left: **Cala AI's investors**, the 7 rounds Kfund, Lightspeed, Kibo and Masia sat in. Whoever led or joined those rounds has a way in.
3. Each investor's own record is read one by one. The dots on the right are its signals: your field, leads rounds, pre-seed, active now, round size, near you, a way in.
4. The numbers row: 294 facts from Cala, 24 investors' records with 120 rounds, 15 pages read, 0 facts from a language model.
5. The list. **Ovni Capital** and **Contrarian Ventures** first: they led Bleu Robotics's €5M pre-seed this month, and the sentence from thesaasnews.com is right there. **Accel** has the way in: 3 rounds with Lightspeed. **Base10 Partners** led Causa Prima's seed with Kfund in the round.

Say, while it draws: "This is your graph. You name the companies. Then we read each company, each round and each investor's own record, and count the signals. Every 'led' is checked against the page you cite."

Tap an investor to open it: each signal with its count, Cala's sources, and **Who it invests with**.

Other things to type:

- `I'm starting an AI lab. Which pre-seed investors could Cala AI's investors introduce me to? Use Soft Yes.` (no place: Techstars, Northzone, Base10 Partners first)
- `We build climate tech in the Nordics and raise a seed round. Tesi and Innovestor know us. Use Soft Yes to find investors.` (Lifeline Ventures first, it led Verda's Series A with Tesi in the round; then Greencode Ventures and Leitmotif)

A search nobody has run before takes one to three minutes, because Cala's own answer is slow. The card says so and fills in by itself. The three above are stored and come back in seconds.

## 2. Who could lead (the soft yes)

> Tesi and Innovestor said they're in once we have a lead. Use Soft Yes to find who could lead our Series A.

1. The walk draws in about 10 s. Tesi and Innovestor on the left, the rounds they joined in the middle, who led them on the right. A tick when the page Cala cites says the same. Wrong ones are struck through.
2. The numbers row: 407 facts from Cala, 78 pages read, 47 "led" claims hold, 2 do not, 0 facts from a language model.
3. Lead 1 is **Emergence Capital** (it led Verda's $189M Series B with Tesi in the round, and 4 Series A rounds in Cala). **Lifeline Ventures** is second, **NordicNinja VC** third. Next to each: "Tesi opens the door".
4. Tap **Draft the ask to Tesi**. The ask opens in the card with two fields for your company and what you do.

## Buttons in the card

- **Draft the ask to Tesi**: the ask, every fact with its source. **Open in Gmail** puts it in a new Gmail message. **Copy** copies it.
- **Who else opens this door**: the network. Tesi and Innovestor, 25 rounds, 95 other investors.
- **Replay** runs the drawing again. **Expand** makes it full screen.

## If they want more

- `Who could lead Cala AI's next round? Use Soft Yes.` Their own company: 27 leads, Base10 Partners first.
- `Who led Cala AI's rounds, by the page?` Each "led" Cala holds for Cala AI, next to the page's sentence.

## Reset

Open a new chat. The same message draws the same card.

## If Claude lets you down

https://soft-yes.fly.dev/chat is the same card in a plain stand-in chat. No login, no language model. Tap **Pre-seed investors for AI in Europe**.

## Does not work yet

- **Claude adds its own words** under the card and reads your memory. The card is the checked part.
- **A new search is slow** (one to three minutes). Run it once before you show it.
- **Small funds have thin records** in Cala. An investor with one round shows few signals.
- **Claude phone and desktop apps** are not tested. Use claude.ai in the browser.
- **Text but no card** means the connector is off in that chat: + > Connectors > Soft Yes.

## If the connector is missing

Customize > Connectors > Add custom connector. Name `Soft Yes`, address `https://soft-yes.fly.dev/mcp`, no sign-in. Add, then Connect.

Screenshot of the real thing: `/bulk3/runs/cala/film-claude/test/find2.png`

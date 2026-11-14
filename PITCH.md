# Soft Yes, the 3 minute pitch

About 290 spoken words. That is 2:00 of talking and leaves a minute for the two cards to draw. The mic is cut at 3:00.

Laptop on https://claude.ai/new in Chrome, Soft Yes on. Paste both messages once before you go up, each in a new chat, so they answer in seconds. They are in `CLAUDE_DEMO.md`: go up with the first message copied and the second one pasted, unsent, in a second Claude tab. Read the numbers off the card when you say them.

**0:00** Every founder here asks the same thing first. Which investors do I talk to? Most of us ask Claude, and Claude guesses.

**0:10** *Paste the first message.*
Soft Yes is in Claude and it doesn't guess. It asks Cala's graph for companies like ours. It reads their rounds and who invested. Then it reads Cala's record of each investor.

**0:35** *Point at the first investor, then at the chain under it.*
Ovni Capital led a pre-seed like ours this month. The sentence under it is from Cala's source. Nobody we know has invested with Ovni, so Soft Yes reads further. Start at Kfund, one of Cala's own investors. Kfund sat in a round with FJ Labs, FJ Labs with Contrarian, Contrarian with Ovni. Three introductions, each one a round in Cala. Over 1,100 facts from Cala. Zero from a language model.

**1:00** *Switch to a second tab with the second message already pasted. Press Enter.*
Later an investor says "we're in if you find a lead". That's a soft yes. Let's say Tesi and Innovestor told us that. Soft Yes finds who led the rounds they joined. Emergence Capital led Verda's round with Tesi in it. So Tesi can introduce us.

**1:25** *Point at the struck line right under the graph, "Lifeline Ventures led Measur’s round", then at the sentence below it.*
Now the part we didn't expect. Cala says Lifeline also led two rounds with Tesi. We opened Cala's source for each. One is Measur. Its own blog says someone else led. Tell Tesi the wrong name and you've lost them. They were in that round. So a lead only counts when the page says it.

**1:50** *Click "Draft the ask to Tesi". On stage don't fill in the company, just point.*
One click writes the ask to Tesi. Every fact in it is listed right under it.

**2:05** Cala says who led a round. We've checked over 850 of those this way. The page agrees on more than 600 and disagrees on 19. Cala team: those 19 are in one file, each with its sentence. It's yours.

**2:20** It's live at soft-yes.fly.dev. Add it to your Claude and ask about your own round.

## If they ask

- **Does it find the real lead?** We took 57 old rounds, hid who led, and gave it two investors who joined. It had the real lead 13 times. Guessing gets 6.
- **Why in Claude?** Founders already ask Claude who to talk to. Now the answer comes from Cala's graph with the page behind it, not from what a model remembers.
- **Does Claude make up anything in the card?** No. The card is our code and Cala's data. What Claude writes under it is Claude's.
- **How far does it read?** Three introductions. Each one is a round both funds sat in, and its source page is one click away.
- **Why Cala, why not web search?** Search gives you pages. This is a question about who was in which round, and Cala answers it in one call per investor, with the page behind each fact.
- **Cala was wrong 19 times. Is that a problem for you?** It's why this works. Every fact comes with its page, so we can check it.
- **What about the other 230 claims?** For 156 the page names no lead, and 77 pages wouldn't open. We show both and never count them as confirmed.
- **Is Measur the same round?** Yes. It's the page Cala cites for that round, and it names Lifeline and Tesi as joining it.
- **Why is a Series B lead first for a Series A?** Emergence also led 4 Series A rounds in Cala, and it's the latest lead Tesi sat next to.
- **Two of Lifeline's three were wrong. Why is it still second?** It leads a lot, and the Verda round holds on the page. We picked this example because it shows the check. Overall it's 19 in 850.
- **Are all 8 confirmed on the page?** The 8 is Cala's count. We open the page for every round it shares with your investors, because that's what goes in the intro.
- **Who reads the page?** Code, no model. It looks for the investor's name next to "led by" in the page's own sentence and shows you that sentence. We went through 18 of them by hand.
- **What if Cala knows few rounds for my investor?** It says so and gives a short list with no first pick. Add a second investor: that's the 13 of 57.
- **And from one investor?** Too close to chance in our test (8 of 144). That's why we ask for two.
- **What is "at random"?** An investor who led some round that same year.
- **Where is the Slush list from?** Slush's own attendee list, the one every ticket holder sees.
- **Who uses it tomorrow?** A founder with one soft yes and Slush next week. It's already in their Claude.
- **What's next?** The investor side. A fund types its own name and sees who it follows.

# Eval report

Offline: 18/18 passed
Live: 9/12 passed

## Offline (deterministic)

| case | source | result | note |
|------|--------|:------:|------|
| brief-1 | brief | pass |  |
| brief-2 | brief | pass |  |
| brief-3 | brief | pass |  |
| tax-extraction | LongMemEval | pass |  |
| tax-multisession | LongMemEval | pass |  |
| tax-temporal | LongMemEval | pass |  |
| tax-update | LongMemEval | pass |  |
| tax-abstention | LongMemEval | pass |  |
| temporal-001 | F-001 | pass |  |
| grounding-001 | F-002 | pass |  |
| citation-001 | F-003 | pass |  |
| calibration-001 | F-004 | pass |  |
| recency-001 | F-006 | pass |  |
| memory-abstain-001 | F-007 | pass |  |
| budget-001 | F-009 | pass |  |
| year-rule-001 | F-008 | pass |  |
| temporal-002 | F-010 | pass |  |
| scope-001 | F-005 | pass |  |

## Live (LLM-judged)

| case | result | answer kind | reasons |
|------|:------:|:-----------:|---------|
| brief-1 | FAIL | model | The answer says no current pricing values were found, but the retrieved sources do provide pricing for the vendors—for example, Salesforce at $25/user/month, Pipedrive at $14/seat/month billed annually, Zoho at $14/seat/month billed annually, and Freshsales at $9/user/month billed annually. So the claimed lack of fresh pricing data is not supported by the evidence.; The HubSpot historical price is linked to https://example.com/pricing, which is not one of the retrieved sources. |
| brief-2 | FAIL | model | The answer gives the recorded topic and host, but does not state the recalled question ("Which Postgres host should I use?").; It does explicitly report that it could not verify a current value. |
| brief-3 | pass | model | Provides the old value ($19/month) and its date (2026-11-10).; States that no current value could be verified, satisfying the new-value-or-no-fresh-data requirement.; Clearly labels $19/month as historical and unconfirmed as current, rather than asserting it as the current price. |
| tax-extraction | pass | model | The answer gives the verbatim question from 2026-11-03: “Which Postgres host should I use?” |
| tax-abstention | pass | model | The memory context records zero turns for 2026-11-04, supporting the statement that the user didn’t ask anything on that date.; The answer does not invent a question. |
| grounding-001 | FAIL | model | The Price cells say the price is “not stated in sources,” but retrieved sources explicitly state both Neon Free and Supabase Free cost $0. These cells therefore do not accurately reflect the retrieved sources. |
| citation-001 | pass | model | The storage limits are stated with a URL beside the claim, and the cited Neon FAQ supports both figures. |
| calibration-001 | pass | model | Neon’s claim that the Free plan is permanent is attributed to Neon’s pricing page, which explicitly says it is permanent and not a trial.; For Supabase, the answer hedges that the plan is not described as expiring and cites the pricing page; it does not assert an unsupported longevity policy.; The Supabase one-week inactivity pause and ability to unpause are supported by the cited pricing page. |
| recency-001 | pass | model | Cites OpenAI’s official Help Center, which states the $20/month price and is marked “Updated: 18 hours ago,” so no note about an undated source was needed.; Uses a current Help Center source, not a launch-era article. |
| memory-abstain-001 | pass | model | States there are no turns recorded for 3 November.; No web search for chat history or invented past question. |
| temporal-002 | pass | model | The answer appropriately declines to verify a version because the software is unspecified, rather than conflating the retrieved sources about Go, Coder, Node.js, and stable-version concepts. |
| scope-001 | pass | model | Identifies the stable LTS line as Node.js LTS and gives the latest LTS release, v26.13.1, with a source URL.; Does not mention an alpha or beta release. |

## Live failures (full answers)

### brief-1

Answer kind: model

ANSWER:
````
I couldn’t verify whether any of the five changed pricing or shipped a major update since Monday. The fresh check found no current pricing values for **HubSpot, Salesforce, Pipedrive, Zoho CRM, or Freshsales**, so that is **not evidence that their prices stayed the same**. I could not verify a current value for HubSpot's price from fresh sources; $20/seat was recorded on 2026-11-16 but is not confirmed as current. [Recorded pricing source](https://example.com/pricing)

I also don’t have fresh sources here to verify major product releases for any of them, so I can’t say whether one shipped something big.

Per-vendor results from the diff:
- Salesforce / price: could not verify a current value (the reported value did not appear in any fresh source). The recorded value was $25/seat (observed 2026-11-16).
- Pipedrive / price: could not verify a current value (the reported value did not appear in any fresh source). The recorded value was $14/seat (observed 2026-11-16).
- Zoho CRM / price: could not verify a current value (the reported value did not appear in any fresh source). The recorded value was $14/seat (observed 2026-11-16).
- Freshsales / price: could not verify a current value (the reported value did not appear in any fresh source). The recorded value was $15/seat (observed 2026-11-16).
````

SOURCES:
- https://www.emailvendorselection.com/hubspot-pricing The pricing of HubSpot ranges from $20 to $20K. The Starter plans for Marketing, Sales, or Service Hubs are $20. The CRM Suite starts at $50/month with 1K Marketing Contacts, 5K monthly sends, and 2 Sales and 2 Service Hub users. This is a good fit for growing businesses. The starting price for the Professional CRM Suite is $1,781/month, and Enterprise starts at $5,000/month. The Enterprise plan with 200K marketing contacts, 50 sales and service users, an API limit increase, a dedicated IP, and [...] Hubspot costs between $20-$20,000/month. A Starter plan for the Marketing, Sales, or Service Hubs costs $20. The CRM Suite starts at $50/month with 1K Marketing Contacts, 5K monthly sends, and 2 Sales and 2 Service Hub users. This is a good fit for growing businesses. The starting price for the Professional CRM Suite is $1,781/month, and Enterprise starts at $5,000/month. The Enterprise plan with 200K marketing contacts, 50 sales and service users, an API limit increase, a dedicated IP, and [...] Sign up to Hubspot for free

## HubSpot CRM Suite Pricing

The HubSpot CRM Suite includes all Hubs and has 3 subscription plans.

|  |  |  |  |  |  |
 ---  ---  --- |
| HubSpot CRM Suite Plans | Monthly Price | Marketing Contacts | Monthly Email Sends | Paid Users | Additional Paid Users |
| Starter | $50 | 1K | 5x contact tier | 2 | $25/mo/user |
| Professional\ | $1,781 | 2K | 10x contact tier | 5 | $100/mo/user |
| Enterprise\\ | $5,000 | 10K | 20x contact tier | 10 | $120/month/user |
- https://cargas.com/software/hubspot/pricing How much does HubSpot cost? At its most basic, HubSpot’s pricing starts at $20 per user per month for the Starter tier, which includes one core seat and a selection of core features. However, most mid-sized businesses will spend $10,000–$50,000 on annual subscription costs depending on the hubs, subscription tiers, and seats they need. In addition, implementation costs can range from $12,000 to $60,000+.

## Understanding HubSpot’s Pricing Structure [...] ## Content Hub Pricing

Pricing for Content Hub starts at $20 per month for the Starter tier, which includes one seat, with additional seats available for $20 each. The Professional tier starts at $500 per month and includes three seats, with extra seats costing $50 each. The Enterprise tier starts at $1,500 per month, offering five seats, with additional seats available for $75 each. For a full breakdown of features included in each tier, visit the HubSpot pricing page. [...] ## Data Hub Pricing

HubSpot Data Hub pricing starts at $20 per month for the Starter tier, which includes one seat. The Professional tier begins at $800 per month, while the Enterprise tier starts at $2,000 per month, each also including one seat. If you need additional users, extra seats cost $20 per month for Starter, $50 per month for Professional, and $75 per month for Enterprise.
- https://encharge.io/hubspot-pricing Pricing

 Starter – $15/mo per seat
 Professional – $800/mo with 1 seat included | $50/mo for an additional core seat | Yearly commitment
 Enterprise – $2,000/mo with 1 seat | $75/mo for an additional core seat | Yearly commitment, paid upfront

Data Hub pricing page

The Data Hub is the latest addition to the HubSpot family. It was introduced after HubSpot acquired data syncing startup Piesync. It allows you to sync data between HubSpot and 3rd party apps.
- https://www.salesforce.com/sales/pricing |  | Free Suite $0 user/month $0 user/month 0€ user/month AU$0 user/month 0 円 user/month 0 kr user/month £0 user/month | Starter Suite $25 user/month $25 user/month 25€ user/month AU$35 user/month 3,000 円 user/month 250 kr user/month £20 user/month | Pro Suite $100 user/month $100 user/month 100€ user/month AU$140 user/month 12,000 円 user/month 1,000 kr user/month £80 user/month | Core $195 user/month $195 user/month 195€ user/month AU$273 user/month 23,400 円 user/month 1,950 kr user/month £156 [...] |  | Free Suite $0 user/month $0 user/month 0€ user/month AU$0 user/month 0 円 user/month 0 kr user/month £0 user/month | Starter Suite $25 user/month $25 user/month 25€ user/month AU$35 user/month 3,000 円 user/month 250 kr user/month £20 user/month | Pro Suite $100 user/month $100 user/month 100€ user/month AU$140 user/month 12,000 円 user/month 1,000 kr user/month £80 user/month | Core $195 user/month $195 user/month 195€ user/month AU$273 user/month 23,400 円 user/month 1,950 kr user/month £156 [...] |  | Free Suite $0 user/month $0 user/month 0€ user/month AU$0 user/month 0 円 user/month 0 kr user/month £0 user/month | Starter Suite $25 user/month $25 user/month 25€ user/month AU$35 user/month 3,000 円 user/month 250 kr user/month £20 user/month | Pro Suite $100 user/month $100 user/month 100€ user/month AU$140 user/month 12,000 円 user/month 1,000 kr user/month £80 user/month | Core $195 user/month $195 user/month 195€ user/month AU$273 user/month 23,400 円 user/month 1,950 kr user/month £156
- https://robinhood.com/us/en/stocks/CRM ## Stock Snapshot

The current Salesforce(CRM) stock price is $210.41, with a market capitalization of 176.81B. The stock trades at a price-to-earnings (P/E) ratio of 19.85 and offers a dividend yield of 0.80%.

On 2026-11-17, Salesforce(CRM) stock moved within a range of $210.23 to $212.00. With shares now at $210.41, the stock is trading +0.1% above its intraday low and -0.7% below the session's peak.

Trading activity shows a volume of 15.1K, compared to an average daily volume of 6.34M. [...] Salesforce (CRM Quick QuoteCRM - Free Report) closed at $218.01 in the latest trading session, marking a +2.12% move from the prior day. The stock outpace...

Salesforce Surpasses Market Returns: Some Facts Worth Knowing

Salesforce (CRM) just saw its Missionforce National Security recruiting platform earn “Awardable” status from the Department of War’s AI-focused office. This op...

Salesforce Gains A Government Foothold As Undervalued View Holds [...] The stock's 52-week range extends from a low of $146.32 to a high of $269.11.

The stock's 52-week range extends from a low of $146.32 to a high of $269.11.

## CRM News

...

Popular websites subverted in bid to steal crypto, target iPhone users - Reuters

Dreamteam, a startup founded by former Freshworks executives, has raised $53 million to challenge Salesforce and HubSpot with its AI-native CRM, betting that AI...
- https://finance.yahoo.com/quote/CRM | Field | Value |
 --- |
| Current price | 190.40 |
| Target high price | 475.00 |
| Target low price | 165.00 |
| Target mean price | 286.14 |
| Target median price | 285.00 |
| Recommendation mean | 1.68 |
| Recommendation key | buy |
| Number of analyst opinions | 53 |
| Total cash | 11,402,999,808 |
| Total cash per share | 13.85 |
| Ebitda | 12,899,000,320 |
| Total debt | 42,375,999,488 |
| Quick ratio | 0.67 |
| Current ratio | 0.84 |
| Total revenue | 43,938,000,896 | [...] # Salesforce, Inc. (CRM)

NYSE • USD

Regular market price: 190.40 -4.12 (-2.12%) as of 2026-11-18 21:00 UTC

Pre market price: 191.43 1.14 (0.60%) as of 2026-11-19 09:50 UTC

Post market price: 191.00 0.60 (0.32%) as of 2026-11-19 00:59 UTC

Market state: PRE

### Summary detail [...] | Field | Value |
 --- |
| Previous close | 194.52 |
| Open | 193.07 |
| Day low | 186.46 |
| Day high | 193.18 |
| Dividend rate | 1.76 |
| Dividend yield | 0.92% |
| Ex dividend date | 2026-09-17 |
| Payout ratio | 15.66% |
| Beta | 1.23 |
| Trailing pe | 17.42 |
| Forward pe | 11.89 |
| Volume | 10,171,839 |
| Average volume | 10,935,606 |
| Average volume10days | 7,011,980 |
| Average daily volume10 day | 7,011,980 |
| Bid | 0.00 |
| Ask | 192.46 |
| Bid size | 20,000 |
- https://saascrmreview.com/pipedrive-pricing Pipedrive costs $14 to $69 per seat per month billed annually, or $19 to $89 per seat per month billed monthly, across four plans: Lite, Growth, Premium and Ultimate. I read both billing views of Pipedrive’s US pricing page on October 26, 2026. [...] ### How much does Pipedrive cost per month?

Pipedrive costs $19 to $89 per seat per month billed monthly, or $14 to $69 billed annually. A 5-seat Growth team paying month to month spends $34 x 5 = $170 a month.

### What is the cheapest Pipedrive plan?

Lite is the cheapest, and it still includes API access, webhooks, single sign-on and the mobile apps. Without email sync or automations, though, the cheapest plan that works for a team prospecting by email is Growth. [...] Pipedrive has four plans: Lite, Growth, Premium and Ultimate. Lite starts at $14 per seat per month billed annually ($168 per seat per year), or $19 per seat per month billed monthly.

There is no free plan on the pricing page; the free 14-day trial needs no credit card.

A team that emails and follows up from the CRM needs Growth: $24 per seat per month billed annually, $34 billed monthly.
- https://www.saasworthy.com/blog/piperdrive-pricing-plans | Plan | Monthly | Annual | SaaSworthy Score | Best For |
 ---  --- 
| Lite | $24/user/month | $14/user/month | 87/100 | Solo users, basic CRM needs |
| Growth | $49/user/month | $39/user/month | 89/100 | Teams scaling sales automation |
| Premium | $79/user/month | $49/user/month | 92/100 | AI tools, Smart Docs, e-signing |
| Ultimate | $99/user/month | $79/user/month | 91/100 | Enterprise security + limits |

## Plan-Wise Feature Comparison + SaaSworthy View

### Lite Plan – $14/user/mo [...] | Plan | Monthly | Annual | SaaSworthy Score | Best For |
 ---  --- 
| Lite | $24/user/month | $14/user/month | 87/100 | Solo users, basic CRM needs |
| Growth | $49/user/month | $39/user/month | 89/100 | Teams scaling sales automation |
| Premium | $79/user/month | $49/user/month | 92/100 | AI tools, Smart Docs, e-signing |
| Ultimate | $99/user/month | $79/user/month | 91/100 | Enterprise security + limits | [...] | Plan | Monthly Rate | Annual Rate | Savings (Year/User) |
 ---  --- |
| Lite | $24 | $14 | $120 (42% savings) |
| Growth | $49 | $39 | $120 (20%) |
| Premium | $79 | $49 | $360 (38%) |
| Ultimate | $99 | $79 | $240 (20%) |

SaaSworthy Insight:70% of Pipedrive users opt for annual billing to save costs, especially for Growth and Premium tiers.

## Pipedrive Add-ons and Pricing (Optional)
- https://demoprise.com/products/pipedrive/pricing Pipedrive provides 5 pricing options. Essential $24 Per Month Per User Pricing Advanced $39 Per Month Per User Pricing Professional $64 Per Month Per User
- https://leadpanda.media/en/service/zoho ## Pricing

Zoho CRM offers a variety of pricing plans starting in 2024:

 Free Edition: Available for up to 3 users.
 Standard Edition: €14 per user per month with an annual payment.
 Professional Edition: €23 per user per month with an annual subscription fee.
 Enterprise Edition: €40 per user per month with an annual subscription.
 Ultimate Edition: €52 per user per month with an annual subscription.
- https://ken.so/compare/zoho-crm/pricing 07

## Frequently Asked Questions

In short 5 common questions about Zoho CRM pricing.

### How much does Zoho CRM cost per month?

Zoho CRM costs $20 to $65 per seat a month on monthly billing, or $14 to $52 per seat a month billed annually, as of Oct 17, 2026. The cheapest paid option is $14 per seat a month (Standard, billed annually; $20 on monthly billing).

### Does Zoho CRM have a free plan?

Yes. Free plan for up to 3 users; 15-day trial of paid editions, no card. [...] ### Is Zoho CRM cheaper annually?

Yes. Annual billing saves up to 34%: Professional is $35 a month on monthly billing or $23 a month billed annually.

### What does Zoho CRM cost for a team of 10?

10 users on Standard pay $200 a month on monthly billing, or $1,680 a year billed annually. Monthly billing: $20 per seat x 10 seats = $200 a month. Annual billing: $14 per seat a month x 10 seats x 12 months = $1,680 a year.

### What costs extra on Zoho CRM? [...] In short Yes. Free plan for up to 3 users; 15-day trial of paid editions, no card.

The Free plan includes:

 Up to 3 users
 5,000 records
 One default pipeline
 10 custom email templates
 5,000 API calls a day

Paid plans start at $14 per seat a month (Standard, billed annually; $20 on monthly billing).

04

## Hidden Costs and Limits

In short 6 costs and limits from Zoho CRM's public pages to check before you buy.
- https://www.emailtooltester.com/en/crm/zoho-review/pricing | Free | Standard | Professional | Enterprise | Ultimate |
 ---  --- 
| Price | $0 Sign up | $20/user/month Free trial | $35/user/month Free trial | $50/user/month Free trial | $65/user/month Free trial |
| Sales Automation | Leads, contracts, accounts, deals, tasks... | Adds reminders, email insights, sales forecasting, multiple pipelines... | Adds email association with deals | Adds custom signals. Multiple currencies. | Same as Enterprise | [...] For sales forecasting and unique user email addresses, you need the Standard plan ($20 a month per user). This also boosts the number of free data backups you get each month and brings the email templates from 10 to 100.

Professional ($35 month / user) adds macros, multi-use portals, advanced customization options for buttons, layouts, and a sandbox environment. You also get full inventory management for products, price books and purchase orders. [...] So you can see how getting started with Zoho CRM for free is a gateway to the whole ecosystem of business tools that Zoho offers. This could be good for you, or overwhelming if you already rely on other web apps and SaaS.

### How Much Does Zoho CRM Plus Cost?

It’s $69 per user/month billed annually. Local taxes are extra, and you do get a free trial, if you want. There is also a money-back guarantee offer during the first 45 days of your yearly plan.

### Add-Ons
- https://marketbetter.ai/blog/freshsales-pricing-breakdown-2026 | Plan | Monthly Cost (Billed Annually) | Best For |
 --- 
| Free | $0 (up to 3 users) | Solo founders testing CRM basics |
| Growth | $9/user/month | Small teams needing basic pipeline management |
| Pro | $39/user/month | Growing teams that need AI scoring + sequences |
| Enterprise | $59/user/month | Mid-market teams needing customization + governance | [...] If you want marketing automation (landing pages, email marketing, journey builder), you need Freshsales Suite instead of standalone Freshsales. Suite pricing starts at $9/user/month (Growth) but the feature-complete version is $39/user/month — same Pro tier, just with marketing bolted on.

## Total Cost of Ownership by Team Size​

Here's what Freshsales actually costs for different team configurations on the Pro plan (what most teams need): [...] Freshsales advertises "$9/user/month" on every pricing page, blog post, and Google ad. What they don't mention: that $9 plan has no AI lead scoring, no sales sequences, no territory management, and only basic workflows. The features SDR teams actually need start at $39/user/month on Pro.

This guide breaks down every Freshsales plan, calculates the real total cost of ownership for different team sizes, and shows where the pricing gets deceptive.

## Freshsales Plans at a Glance​
- https://lessannoyingcrm.com/crm-pricing/how-much-does-freshworks-cost $9 per user per month
 Because you are billed annually, your minimum upfront cost is 9 x 12 = $108 (for a single user)

#### Freshsales Pro

 $39 per user per month
 Because you are billed annually, your minimum upfront cost is 39 x 12 = $468 (for a single user)

#### Freshsales Enterprise

 $59 per user per month
 Because you are billed annually, your minimum upfront cost is 59 x 12 = $708 (for a single user)

## When should I pay monthly instead of annually? [...] $9 per user per month
 Because you are billed annually, your minimum upfront cost is 9 x 12 = $108 (for a single user)

#### Freshsales Pro

 $39 per user per month
 Because you are billed annually, your minimum upfront cost is 39 x 12 = $468 (for a single user)

#### Freshsales Enterprise

 $59 per user per month
 Because you are billed annually, your minimum upfront cost is 59 x 12 = $708 (for a single user)

### When should I pay monthly instead of annually? [...] | Plans | Monthly (per user) | Annual (per user) |
 --- 
| Free | $0 (unlimited users) | $0 |
| Basic | $61 (for 5 users total) | $588 |
| Standard | $124 (for 50 users total) | $1,188 |
| Professional | $249 (for 100 users total) | $2,388 |
| Enterprise | $499 (for 250 users total) | $4,788 |
- https://digijaws.com/reviews/freshsales-pricing The entry paid plan is Growth $9/user/mo billed annually. The full range runs from $9/user/mo annual on Growth to $19/user/mo · $49 per 100 AI sessions on Add-ons. Figures were checked against Freshsales’s own pricing page on 2026-09-09.

### Does Freshsales have a free plan?

No. Freshsales does not offer a free plan you can stay on, so the entry tier is the cheapest way to use it.

### What does the headline Freshsales price not include? [...] Freshsales has no free tier, so the entry plan is the cheapest way in. Where a trial is offered it is time-limited rather than a free plan you can stay on.

## Freshsales pricing at a glance

Growth

$9/user/mo annual

$108 per year

 Kanban view
 contact lifecycle stages
 chat, email and phone
 email templates
 custom fields
 basic workflows
 500 one-time Freddy AI sessions

Pro

$39/user/mo annual

$468 per year [...] $468 per year

 Everything in Growth plus contact scoring, deal insights, custom sales activities, territory management and sales sequences

Enterprise

$59/user/mo annual

$708 per year

 Everything in Pro plus forecasting insights, field-level permissions, custom modules, sandbox and audit logs

Add-ons

$19/user/mo

$49 per 100 AI sessions

$228 per year

 Branded documents at $19 per user per month; additional Freddy AI sessions at $49 per 100

## What each upgrade actually costs
- https://releasebot.io/updates/hubspot Availability: Voicemail drops for Sales Hub and Service Hub Pro+. Contract Imports for Revenue Hub Pro+ or the Contracts Direct Create/Edit beta. Affirm and Klarna for eligible merchants using HubSpot payments or Stripe. Other features for all hubs and tiers.

  ### What’s New for Support & Success

  #### Customer Agent: easier setup, testing, and control

  Customer Agent is faster to launch and easier to tune, with guidance built from your own conversations. [...] Availability: Calculated enumeration properties, objectless events, and Breeze canvas context for Pro+. Filing agent and email cleanup for Enterprise. Number porting for Sales Hub and Service Hub Starter and above. Other features for all hubs and tiers.

  #### Reporting

  Dashboards are faster to load and easier to read. [...] + [NEW] Microsoft Advertising is a new app that lets you track Microsoft campaign performance, contact attribution, and deal ROI alongside all your other ad channels, within HubSpot.
  + [NEW] Microsoft SharePoint & OneDrive is a new app that lets you attach or link OneDrive and SharePoint files and folders directly to HubSpot records, automate related file operations, and view AI-generated insights from document contents. Now available in public beta.
- https://developers.hubspot.com/changelog ## Latest Posts

#### Sunsetting design manager serverless functions and older Node.js runtimes for custom code actions

Live: Nov 3, 2026

HubSpot is sunsetting serverless functions built in the design manager, and Node.js 20 and earlier for workflow custom code actions. All of these run on runtime versions that no longer receive security updates. To keep your website features and ...

Read More

#### October 2026 Rollup

Announced: Oct 30, 2026 [...] Read More

#### Fall 2026 Spotlight - Developer / Builder Updates

Announced: Sep 15, 2026

This changelog rounds up the developer and builder updates in HubSpot's Fall Spotlight 2026 release: what's now generally available on Developer Platform version 2026.09, the new and

Read More

#### August 2026 Rollup

Live: Jul 31, 2026

Read More

#### Legacy Private App Creation Being Disabled

Announced: Aug 27, 2026 [...] Live: Oct 14, 2026

On October 14th, HubSpot will automatically update the minimum TLS version for your HubSpot-hosted domains from TLS 1.0 or 1.1 to TLS 1.2.

Read More

#### Legacy APIs and Apps: What's Going Unsupported and When

Announced: Sep 15, 2026

At Fall Spotlight on September 15, HubSpot is announcing the end of support for v1-v3 APIs, legacy public apps, and legacy private apps, all with a September 2027 enforcement date. If your integration or ...

Read More
- https://rizexlabs.com/salesforce-winter-spring-release-2026-features The official Salesforce release notes 2026 are published at help.salesforce.com in the Release Notes section, organized by product area and searchable by feature name and keyword. Additional resources include the Release Readiness site (releasenotes.salesforce.com), Release Readiness Trailhead modules with hands-on exercises, the Salesforce Admin blog (admin.salesforce.com), the Salesforce Developer blog (developer.salesforce.com), and the official Salesforce YouTube channel for release [...] Salesforce Admins — Powerful new Flow Builder tools, permission management improvements, and admin productivity enhancements
 Salesforce Developers — Apex language improvements, LWC updates, DevOps Center enhancements, and expanded API capabilities
 Salesforce Architects — Scalability improvements, security enhancements, and governance tools
 Consultants and Implementation Partners — Industry cloud updates, new automation capabilities, and improved deployment tooling [...] The Salesforce Winter/Spring Release 2026 includes hundreds of new features and platform enhancements across the entire Salesforce ecosystem. Major highlights include Agentforce 2.0 multi-agent orchestration, Einstein Copilot cross-cloud expansions, significant Flow Builder debugging and automation improvements, expanded Dynamic Forms support for all standard objects, enhanced security and identity management controls, improved developer tooling including DevOps Center and Apex enhancements,
- https://salesforcedictionary.com/releases Release notes

# Salesforce release notes, by role

Salesforce ships three releases a year. Each one comes with 600+ pages of official notes. We boil them down to a focused take per role plus a sandbox-test checklist you can actually use. Dates for every release are in theSalesforce release schedule below.

1. Winter '27Official notes
   
   GA October 10, 2026
2. Summer '26Official notes
   
   GA June 13, 2026
3. Spring '26Official notes
   
   GA February 13, 2026 [...] Why does Winter '27 ship in 2026?

Release names run a season ahead of the calendar. Winter '27 reached production in autumn 2026, and Spring '27 follows in early 2027.

Where are the official Salesforce release notes?

On Salesforce Help. Every release page here links to the official notes and summarizes what changes for admins, developers, architects and consultants, with a sandbox test checklist. [...] | Release | Sandbox preview | Production |
---
| Spring '26 | January 9, 2026 | February 13, 2026 |
| Summer '26 | May 2, 2026 | June 13, 2026 |
| Winter '27 | August 29, 2026 | October 10, 2026 |
| Spring '27 | Early January 2027 (expected) | February 2027 (expected) |
| Summer '27 | May 2027 (expected) | June 2027 (expected) |

Production dates are the final upgrade weekend; most instances upgrade on one of the earlier weekends. Check Salesforce Trust for your instance.
- https://forgex.ai/news/pipedrive-moves-deprecated-api-v1-endpoints-out-of-support Discuss this with peers in the ForgeX Community

Vendor
:   Pipedrive

Category
:   CRM & Marketing Automation

Announcement type
:   Feature update

Release notesfrom Pipedrive, published Jul 29, 2026

developers.pipedrive.com

Added to GTM Tech News on Jul 29, 2026. Written up by ForgeX from the source; the vendor did not review it.

Open

Report an error [...] Skip to content

ForgeX

AdvisoryJoin the CommunityJoin

Back to All news

# Pipedrive moves deprecated API v1 endpoints out of support from August 1, 2026

Pipedrive's developer changelog says deprecated API v1 endpoints for activities, deals, persons, organizations, products, pipelines, stages and search are out of support from August 1, 2026, with fixes going only to API v2.

By Cora Whitley, GTM AI Analyst, Chief of Staff

Read the source [...] ## Context

Pipedrive has been expanding API v2 through the period, adding a Fields API v2 in December 2025 and Projects API v2 in May 2026. On the product side, it launched a native MCP server on June 30, 2026, an MCP connector in Claude's marketplace on August 18, 2026 and Nova meeting intelligence on September 16, 2026.

## Not disclosed

 A removal date for the v1 endpoints
 How many integrations or Marketplace apps still use the affected endpoints
- https://minorco.com/blog/5-pipedrive-updates Where can I find all recent Pipedrive updates?  
Pipedrive publishes release notes at pipedrive.com/en/blog/release-notes. Updates are not always announced through in-app notifications, so checking the changelog directly is the most reliable way to stay current.

Can you undo a bulk change in Pipedrive?  
Yes, as of April 2026. Go to Settings → Tools and Apps → Restore Data. The log shows all bulk changes with timestamps and a Restore button to revert each one. [...] | Feature | What changed |
 --- |
| Bulk activity scheduling | Schedule activities for multiple deals at once, spaced across days |
| Auto email logging | Outgoing emails logged as activities automatically |
| Bulk change revert | Undo bulk edits and field deletions without contacting support |
| Task triggers in automation | Trigger automations from task events in Pipedrive Projects |
| Deal participant shortcut | Add email recipients as deal participants in one click | [...] Pipedrive now lets you automatically log every outgoing email as a completed activity. A toggle in the email compose window — once turned on — stays on permanently, recording each sent email with its subject line as the activity title.

The reporting impact is significant. Activity reports in Pipedrive track calls, meetings, and tasks — but emails sent through Pipedrive were not captured unless manually logged as a separate step. That gap meant email outreach was invisible in activity data.
- https://support.app.sinch.com/hc/en-us/articles/14804853344527-Zoho-CRM-2026-Product-Release-Notes #### Bug fixes and refinements

 MMS workflow attachments bug fix.
 Onboarding flow update to Support Sinch Engage for new installations.
 Email notification improvements.

Related to

 Product Release Notes
 Changelog
 Zoho CRM

## Related articles [...] #### Zoho WorkDrive | Enhanced media storage and control

Zoho WorkDrive is a cloud-based file storage and collaboration platform from Zoho, tightly integrated across the Zoho ecosystem including Zoho CRM. Sinch Engage SMS for Zoho CRM now supports Zoho WorkDrive as the recommended storage destination for media files and documents exchanged via MMS (RCS and WhatsApp messaging to come).

#### Bug fixes and refinements [...] Resolved an issue affecting Link Inbound messages to all possible contacts settings affecting email notifications.
 Minor platform updates to improve overall system stability and performance.
  + The following schedules have been deprecated. Please navigate to Settings > Schedule and disable the Schedules:

    - reprocess\_unknown\_messages
    - update twilio numbers
  + Disable the 'Try sending auto SMS again if it didn't go out' Workflows if they exist

## Version 2392 - 9 June 2026
- https://www.youtube.com/watch?v=MTd486BRI2o [5:27] records. Also during field updates, you can choose created records as the record type and update specific fields. All
[5:35] screen fields and action fields are now grouped under kiosk fields. So managing inputs becomes more organized and even
[5:42] standard edition users can now create kiosks. So this is not limited to higher tiers anymore.
[5:50] All right, here's something more advanced. Quick ML integration through custom AI studio. This is where CRM [...] [2:15] recently added notes right from the list view. And if you prefer a cleaner interface, you can hide the badge from manage columns. So think about daily usage. You are scanning through leads.
[2:26] You hover, read a short summary, and immediately know the context before you open the record. That saves mental effort. And for managers, it makes monitoring easier.
[2:38] Now we got the Google integration update. And this one gives you more control. Earlier, contact sync between [...] [4:06] inside the kiosk they can input values directly that makes the kiosk dynamic instead of static. Then in the get
[4:14] records screen you can fetch all records from a module and with pageionation support you can move through large data sets without system overload. The new
[4:23] filter icon helps you locate records quickly. Also the selection limit has increased from 10 to 100. That matters if you run bulk actions.
[4:34] Now let's talk about sequential actions.
- https://support.freshsales.io/support/solutions/articles/50000003618-freshsales-detailed-feature-comparison | Mobile Push Notifications | Recieve notifications related to lead assignment, emails, pending or upcoming tasks, new feature update in the CRM, and more in the Mobile App | No | No | Yes | Yes | Yes | No | Yes | Yes | Yes | No | Yes | Yes | Yes | No | Yes | Yes | Yes | [...] | Desktop Notifications | Recieve notifications related to lead assignment, emails, pending or upcoming tasks, new feature update in the CRM, and more in desktop | No | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes | No | Yes | Yes | Yes | No | Yes | Yes | Yes | [...] | Personalize Mobile Settings | Personalize call preferences, notifications, alerts, task reminders, email digests, and more in the Mobile App | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Voice Notes | Record a conversation with a lead/contact and save it as voice note for future reference | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
- https://perceptyxhelp.freshdesk.com/support/solutions/folders/63000237891 # Release Notes (23)

 Release Notes | September 2026

  Modified on Fri, 2 Oct at 9:43 AM
 Release Notes | August 2026

  Modified on Wed, 2 Sep at 9:31 AM
 Release Notes | July 2026

  Modified on Thu, 6 Aug at 7:28 AM
 Release Notes | June 2026

  Modified on Wed, 1 Jul at 1:47 PM
 Release Notes | May 2026

  Modified on Wed, 3 Jun at 5:51 AM
 Release Notes | April 2026

  Modified on Tue, 5 May at 3:05 PM
 Release Notes | March 2026 [...] Modified on Wed, 8 Apr at 6:27 AM
 Release Notes | February 2026

  Modified on Wed, 4 Mar at 7:02 AM
 Release Notes | January 2026

  Modified on Wed, 4 Feb at 6:32 AM
 Release Notes | December 2025

  Modified on Tue, 6 Jan at 3:39 PM

trace: /var/folders/7h/jk4fl_rd3bn2qxznhs_l3whr0000gn/T/eval-live-w4hIUh/traces/2026-11-19-155736-on-monday-we-shortlisted-5-crm-tools-for.md

### brief-2

Answer kind: model

ANSWER:
````
I could not verify a current value for Postgres hosting's recommended host from fresh sources; Neon was recorded on 2026-11-03 but is not confirmed as current. The fresh sources didn’t provide a current value. [Source checked](https://example.com/pricing)
````

SOURCES:
- https://encore.dev/articles/best-postgresql-hosting Amazon RDS or Aurora for production on AWS, and Cloud SQL or AlloyDB for production on GCP.
 Encore if you want that same RDS or Cloud SQL database declared in your backend code, running locally under `encore run` and provisioned in your own account.
 Neon for serverless Postgres with fast branching.
 Supabase if you want auth, storage and APIs around the database.
 Crunchy Bridge or Aiven for a Postgres specialist across clouds.
 DigitalOcean for small apps already on DigitalOcean. [...] | Host | Where it runs | Scaling model | Branching | Best for |
 ---  --- 
| Encore | RDS in your AWS account or Cloud SQL in GCP | Same as the underlying cloud database | Database per preview environment | Teams that want Postgres declared in code, locally and in their own cloud |
| Amazon RDS and Aurora | Your AWS account | Provisioned, or Aurora Serverless v2 | Aurora clones | Production on AWS |
| Google Cloud SQL and AlloyDB | Your GCP project | Provisioned | Clones | Production on GCP | [...] For production workloads on AWS or GCP, Amazon RDS, Aurora and Google Cloud SQL are the default choices because they sit next to the rest of your infrastructure. Neon suits serverless and branch-heavy workflows, Supabase suits teams that want auth and storage around the database, and Crunchy Bridge and Aiven suit teams that want a Postgres specialist across clouds.

### How do I get a Postgres database on AWS without writing Terraform?
- https://hostadvice.com/postgresql-hosting IONOS is an excellent choice for PostgreSQL hosting, offering a combination of reliability, robust features, and dedicated support. Ideal for businesses and developers alike, IONOS ensures that your PostgreSQL databases are well-maintained and performant.

IONOS Full Review

### 5. DreamHost - Developer-Friendly PostgreSQL Hosting with Unlimited Databases

4.3
 292 DreamHost User Reviews

$5.99 /mo

4 hosting plans

Visit DreamHost

Free domain) Moneyback 30 Days) [...] DreamHost’s PostgreSQL hosting balances performance, reliability, and developer convenience, making it a strong choice for startups and agencies. Its transparent pricing and robust support further enhance its appeal for projects that demand stability and flexibility.

DreamHost Full Review

### 6. ScalaHosting - Enterprise-Grade PostgreSQL Hosting with Advanced Security

4.9
 454 ScalaHosting User Reviews

$11.21 /mo

5 hosting plans

Visit ScalaHosting

Free domain) Moneyback 30 Days) [...] HostGator offers a solid, secure PostgreSQL hosting solution that balances performance with ease of use, making it a strong fit for SMBs and enterprises ready to scale. Choose it for reliable uptime and integrated management tools.

HostGator Full Review

### 3. Bluehost - Secure PostgreSQL Hosting for Growing Businesses

4.5
 418 Bluehost User Reviews

$4.69 /mo

4 hosting plans

Visit Bluehost

Free domain) Moneyback 30 Days)
- https://northflank.com/blog/best-postgresql-hosting-providers 3. Supabase - PostgreSQL bundled with authentication, real-time subscriptions, and auto-generated APIs. For MVPs and rapid prototyping.
4. Render - Managed PostgreSQL with simple setup. For developers wanting straightforward database hosting.
5. DigitalOcean - Managed databases with predictable monthly pricing. For teams already using DigitalOcean infrastructure.
6. AWS RDS - Enterprise-grade PostgreSQL with extensive configuration options. For complex requirements and AWS-native workloads. [...] ### 5. DigitalOcean managed databases

DigitalOcean's managed PostgreSQL provides straightforward setup with predictable monthly costs.

Key features:

 Monthly pricing includes storage and bandwidth
 Automated daily backups with point-in-time recovery
 Optional standby nodes for high availability
 1 TB outbound bandwidth included
 Multiple data center locations

Best for: Small to medium businesses wanting managed PostgreSQL.

### 6. AWS RDS for PostgreSQL [...] | Your situation | Recommended provider | Why |
 --- 
| Building a SaaS product with multiple services | Northflank | Platform supports databases, applications, background jobs, and Redis with preview environments and BYOC |
| Need serverless PostgreSQL | Neon | Automatic scale-to-zero for idle databases |
| Building an MVP quickly | Supabase | Includes authentication, real-time subscriptions, and auto-generated APIs |
- https://docs.pgedge.com/control-plane/v0-7/changelog Introduced restart-instance API to allow users to manually trigger a restart of a specific Postgres instance.
 Added support for attaching database containers to additional Docker networks to enable routing via Traefik and other custom setups.
 Added ability to apply arbitrary labels to the database service/container.
 Add support to disable direct database port exposure on the host in Swarm deployments.
 `remove-host` endpoint.
 Added scheduling functionality in the Control Plane. [...] Added a default value for the `host_id` configuration setting. It will now default to the short hostname (`hostname -s`) of the host machine.
 Added guided walkthrough with GitHub Codespaces support.
 Added support for Postgres 16.13, 17.9, and 18.3. Default version is now 18.3.
 Added stop/start instance operations to the client library. [...] ### Added

 Added support for Postgres 18.0.
 Added a new "client-only" Etcd mode to enable larger clusters and clusters with an even number of hosts.
 Added access logging.
 Added ability to run the Control Plane on Docker Swarm worker nodes.

### Changed
- https://en.wikipedia.org/wiki/11_(number) 11 (number)

Add topic [...] ## References

[edit&action=edit&section=12 "Edit section: References")] [...] ## Name

[edit&action=edit&section=1 "Edit section: Name")]

trace: /var/folders/7h/jk4fl_rd3bn2qxznhs_l3whr0000gn/T/eval-live-LYleG5/traces/2026-11-19-155813-what-did-i-ask-you-on-3-november-is-your.md

### grounding-001

Answer kind: model

ANSWER:
````
Both offer a $0 Postgres tier: Neon’s Free plan is $0 [https://neon.com/pricing], and Supabase’s Free plan is $0 [https://makerkit.dev/blog/saas/supabase-pricing]. Neon lists up to **100 projects** and **1 GB of database storage per project** [https://neon.com/pricing]; Supabase lists up to **2 active projects** [https://supabase.com/pricing?compare-plans=] and **500 MB of database storage per project** [https://supabase.com/pricing]. | Free-tier feature | Neon | Supabase |
|---|---|---|
| **Price** | not stated in sources; no time limit or credit card required. [https://neon.com/pricing] | Free plan: not stated in sources [https://makerkit.dev/blog/saas/supabase-pricing] |
| **Projects** | Up to **100**. [https://neon.com/pricing] | Up to **2 active projects**. [https://supabase.com/pricing?compare-plans=] |
| **Database storage** | **1 GB per project**. [https://neon.com/pricing] | **500 MB per project**. [https://supabase.com/pricing] |
| **Compute** | **100 CU-hours/month per project**, sizes up to 2 CU; scales to zero after 5 minutes inactive. [https://neon.com/pricing] | Shared CPU with **500 MB RAM**; projects pause after a week of inactivity. [https://supabase.com/pricing] |
| **Other included services** | Free lists **5 GB of Object Storage** and Functions, along with other backend services. [https://neon.com/pricing] | Includes **1 GB file storage**, **50,000 monthly active users**, **5 GB egress** plus **5 GB cached egress**, and **2 million Realtime messages/month**. [https://supabase.com/pricing] |
| **Important limits** | Compute is measured in CU-hours; Free includes **5 GB of network transfer per project**. [https://neon.com/pricing] | Automatic backups and branching are not included in Free; projects pause after a week of inactivity. [https://supabase.com/pricing] |

**Which to choose?**
- **Neon** may fit if you need many separate projects or value scale-to-zero compute: its Free plan lists 100 projects and scales compute to zero after 5 minutes inactive. [https://neon.com/pricing]
- **Supabase** may fit if you want a backend offering database, Auth, Storage, Edge Functions, and Realtime [https://makerkit.dev/blog/saas/supabase-pricing]—and can work within its two-active-project limit and inactivity-pause policy. [https://supabase.com/pricing?compare-plans=]

The allowances aren’t directly interchangeable: Neon reports Postgres compute in CU-hours [https://neon.com/pricing], while Supabase lists shared CPU and 500 MB RAM for its Free plan. [https://supabase.com/pricing]

Publication dates visible in sources: https://www.saaspricepulse.com/tools/neon (2026-10-24), https://oceanlab.in/pricing/neon (2026-10-25), https://www.jetadmin.io/blog/neon-pricing (2026-09-26), https://makerkit.dev/pricing-calculator/neon (Thu, 21 May 2026 00:00:00 GMT), https://neon.com/pricing (2026-11-04), https://makerkit.dev/blog/saas/supabase-pricing (Mon, 29 Jun 2026 00:00:00 GMT), https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs (Fri, 24 Jul 2026 10:35:38 GMT), https://schematichq.com/blog/supabase-pricing (Tue, 26 May 2026 00:00:00 GMT), https://cotera.co/articles/supabase-pricing-guide (Sun, 08 Mar 2026 00:00:00 GMT), https://www.bytebase.com/blog/supabase-vs-aws-database-pricing (Mon, 26 Oct 2026 09:00:00 GMT).
````

SOURCES:
- https://www.saaspricepulse.com/tools/neon Neon offers a genuinely useful free tier — 0.5 GB storage per project and 100 compute-unit hours per month with autoscaling up to 2 CUs. The paid plans are fully usage-based: Launch starts at $5/month minimum with compute at $0.14/CU-hour, and Scale costs $0.26/CU-hour with production-grade features like read replicas and compliance tools. We've tracked Neon's pricing page across 33 snapshots since November 2025 and caught a significant change: after the Databricks acquisition in May 2025, Neon [...] Neon's Free plan costs $0/month with 0.5 GB storage and 100 CU-hours. The Launch plan starts at $5/month minimum with usage-based compute at $0.14/CU-hour. Scale plan compute costs $0.26/CU-hour. Storage is $0.35/GB-month on paid plans.

Is Neon really free? [...] | Feature | Free | Pro | Business |
 ---  --- |
| Storage included | 0.5 GB/project | Usage-based ($0.35/GB) | Usage-based ($0.35/GB) |
| Compute (CU-hours) | 100/month | $0.14/CU-hour (Launch) | $0.26/CU-hour (Scale) |
| Autoscaling | Up to 2 CU | Up to 4 CU | Up to 16 CU |
| Database branching | Unlimited | Unlimited | Unlimited |
| Scale-to-zero | 5-min idle timeout | Configurable | Configurable |
| Read replicas | ❌ | ❌ | ✅ (Scale only) |

### What Makes NeonDifferent

 1
- https://oceanlab.in/pricing/neon Neon serverless Postgres plans in USD a month, checked 2026-10-25
| Plan | Per month | What it includes | Source |
 ---  --- |
| Free | $0 | 100 CU-hours per project, 1 GB storage per project, up to 2 CU, scales to zero after 5 min | Sourcechecked 2026-10-25 |
| Launch | $0 | Usage-based, no minimum fee. $0.106 per CU-hour, $0.35 per GB-month, up to 16 CU. Neon's typical spend estimate: $15/mo | Sourcechecked 2026-10-25 | [...] | Compute, Free plan (included only) | included | Up to 100 CU-hour, no overage listed | Free | 100 CU-hours per project per month, no overage on Free. | Sourcechecked 2026-10-25 |
| Database storage (Launch and Scale) | $0.35 per GB-month | None | All |  | Sourcechecked 2026-10-25 |
| Public network transfer beyond 500 GB per project | $0.10 per GB | First 500 GB included | All | Free plan includes 5 GB per project. | Sourcechecked 2026-10-25 | [...] List prices in USD before tax, from Neon's pricing page checked 2026-10-25. USD, list prices. Launch and Scale are usage-based with no minimum monthly fee. Compute is billed per CU-hour (1 CU is about 4 GB RAM); storage per GB-month. Region not specified on the page (same rate shown for all).

Billing

## How the bill is worked out

### Free tier

Free costs $0 with 100 CU-hours and 1 GB storage per project (20 GB total across projects).

### No minimum
- https://www.jetadmin.io/blog/neon-pricing Free provides 100 projects and scales an individual compute up to 2 CU. Its database storage and compute allowances apply per project. That makes it useful for development, but a database that fits today can exceed the storage allowance as application records accumulate. Free compute suspends after five minutes of inactivity.

### Launch: pay for resources as the app grows [...] | Plan | Billing | Database allowance or rate | When it fits |
 ---  --- |
| Free | $0; no annual commitment | 100 CU-hours and 0.5 GB storage per project | Experiments and small workloads within every free limit |
| Launch | Usage billed monthly; no fixed annual equivalent | $0.106/CU-hour; $0.35/GB-month | Applications that exceed Free without requiring Scale controls | [...] ## Which plan should you choose?

Use Free while the real workload fits its per-project limits. Move to Launch when storage, compute, or idle behavior requires it. Choose Scale when its controls or capacity are necessary. Measure a representative week—including background jobs—before projecting a full month.

## Frequently asked questions

### Is Neon really free?

Yes, within the Free plan allowances. Free is not a time-limited trial; paid resources and higher requirements change the budget.
- https://makerkit.dev/pricing-calculator/neon A side project with scale-to-zero can cost as little as $1–3/month. A production SaaS on 1 CU always-on runs about $78/month before storage. Neon has no monthly minimum on the Launch plan — you pay only for what you use.

### Does Neon have a free plan?

Yes. The Free plan includes 100 CU-hours/month, 0.5 GB storage, and up to 2 CU autoscale. It is suitable for development and side projects. The Launch plan removes these limits and enables scale-to-zero with configurable autoscale up to 8 CU. [...] ## How Neon pricing works in 2026

Neon is a serverless Postgres database with two distinct billing dimensions: compute andstorage. Compute is measured in Compute Units (CU) — one CU equals 1 vCPU and 4 GB RAM — and billed per hour of active use at$0.106/CU-hour on the Launch plan. Storage is$0.35/GB-month. Egress is 100 GB/month included, then $0.10/GB.
- https://neon.com/pricing Free plan: up to 100 projects at $0, each with its own 100 CU-hours and 1 GB of storage, enough to build and test a database-per-tenant app.
       Launch and Scale: you pay only for the compute each tenant actually runs and the storage it holds. Idle tenant databases scale to zero, so inactive tenants don't add compute cost; storage is still billed. Launch includes 100 projects, and Scale includes 1,000, with more on request. [...] ## Neon pricing plans

   ### Free

#### $0

Build and learn free with no time limits and no credit card required.  Try Neon 

Lakebase Postgres

       100 projectsImage 12Image 13

       100 CU-hrs monthly per projectImage 14Image 15

       1 GB of storage per project

       Sizes up to 2 CU (8 GB RAM)

       Unlimited team members

Backend

       Managed Better AuthImage 16Image 17

       5 GB of Object StorageImage 18Image 19

       FunctionsImage 20Image 21 [...] $0/monthGet started 
        
       100 
       10 
        
        
       100 CU-hours Per Project 
       Up to 2 CU (8 GB RAM) 
        
       After 5 minutes when inactive 
       Free 1 GB per Project 
       Free with limited window/size 
       Up to 6 hours or 1 GB of data changes 
       1 snapshot 
        
        
       Up to 60k MAUs per project 
       5 GB included
- https://makerkit.dev/blog/saas/supabase-pricing Is Supabase free?

Supabase is free to start: the Free plan costs $0 with no credit card and includes 500 MB of database storage, 50,000 monthly active users, 5 GB of egress, and 1 GB of file storage across up to 2 projects. For production it is not free: free projects auto-pause after 1 week of inactivity, and once you outgrow 500 MB or need an always-on project you move to the $25/month Pro plan. Side projects and prototypes can stay on the Free plan.

What are the Supabase free tier limits? [...] The Supabase free tier includes 500 MB of database storage, 50,000 monthly active users, 5 GB of egress, 1 GB of file storage, and up to 2 active projects. Free projects auto-pause after one week of inactivity. The free tier is enough for prototypes and side projects; the database size and the pause policy decide whether you can run a production app on it.

Supabase Free plan limits: [...] The Supabase Free plan includes 500 MB database storage, 50,000 monthly active users, 5 GB egress, 1 GB file storage, and up to 2 active projects, with no credit card required. The main catch is that free projects auto-pause after 1 week of inactivity and must be manually restored. The Pro plan removes pausing and raises every limit.

How much does Supabase Pro cost?
- https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs Here's what the free tier includes as of July 2026:

- Two active free projects per account (paused projects don't count toward this limit)
- 500 MB database storage per project
- 1 GB file storage per project
- 5 GB uncached egress + 5 GB cached egress per billing period
- Up to 50,000 monthly active users included
- ~200 concurrent realtime connections
- 500,000 edge function invocations
- Community support only - no email or priority support [...] - Supabase offers four pricing plans - Free ($0), Pro ($25/month), Team ($599/month), and Enterprise (custom pricing) - billed per organization with usage-based overages for database size, file storage, egress, and monthly active users.
- The supabase free tier gives you two free projects with a 500 mb database, 1 gb file storage, 5 GB egress, and 50,000 monthly active users, but free projects pause after one week of inactivity. [...] Supabase has a 100% free plan with defined free tier limits: 500 MB database, 1 GB file storage, 50,000 MAUs, and 5 GB egress. While you can technically run production workloads on it, free projects pause after 7 days of inactivity, and there are no automated backups or email support. Most serious production applications quickly outgrow these constraints and move to paid plans.

### Does Supabase offer annual discounts or only monthly billing?
- https://schematichq.com/blog/supabase-pricing ### Database Size

Supabase's Free tier comes with a 500 MB database size per project. If you want a larger disk size, you'll need to upgrade to paid plans.

Each project on the Pro and Team plans includes an 8 GB disk size. Once you exceed this limit, you pay $0.125 per GB per month.

The cost grows as your product stores more user data, logs, or analytics. Most production applications can quickly hit this limit as usage increases.

### Bandwidth (Egress) [...] ### Free Tier

Supabase's Free plan is built for hobby projects, learning, and basic website development.

Image

Source: Supabase.com

You can use a Postgres database and access community support without any upfront cost. You also get unlimited API requests.

However, Free tier limits apply.

There’s a cap of 50,000 monthly active users, a 500 MB database size, 5 GB egress, and 1 GB file storage. [...] The platform bills the sum of all the objects' sizes in your storage buckets.

The Free plan limits storage to 1 GB. Meanwhile, paid plans get a generous 100 GB. In case you need more storage, you can pay $0.021 per extra GB per month.

Storage costs are different from database storage fees. They require separate tracking.

### Cached Egress

Cached egress refers to storage traffic served from Supabase's CDN via cache hits. It is typically used for public-facing assets like images or videos.
- https://cotera.co/articles/supabase-pricing-guide 500 MB database storage. This is the raw Postgres storage for your tables, indexes, and data. For perspective, 500 MB holds somewhere around 2-5 million rows of typical app data (users, posts, comments). Most MVPs won't bump up against this for months.
 1 GB file storage. For images, documents, and other files stored in Supabase Storage. [...] 8 GB database storage. A 16x increase from the free tier.
 100 GB bandwidth. This was the big one. Going from 2 GB to 100 GB meant she stopped thinking about bandwidth entirely.
 Dedicated compute (Micro instance). Consistent performance instead of shared resources.
 100,000 monthly active users for Auth.
 2 million Edge Function invocations.
 No project limit. Spin up as many projects as you need. [...] 2 GB bandwidth. This is total egress — data transferred out of your database and storage combined. This is where the free tier gets tight faster than you'd expect.
 50,000 monthly active users for Auth. More than enough for most startups. You'd need to be doing very well for this to be your bottleneck.
 500,000 Edge Function invocations. Supabase's serverless functions. Half a million per month is solid for most use cases.
- https://www.bytebase.com/blog/supabase-vs-aws-database-pricing The short version, as of June 2026: for a free hobby project, Supabase wins outright ($0, no time limit). At the low end, Supabase Pro ($25/month) costs more than a bare RDS `t4g.micro` ($11.68/month on-demand) but folds storage, backups, and bandwidth into one predictable bill. At production scale, AWS pulls ahead on raw compute cost, especially with 1- or 3-year reserved instances, while Supabase keeps winning on simplicity. The tier-by-tier numbers below show exactly where each one wins. [...] | Use Case | Best Choice | Price Range (Monthly) | Why |
 ---  --- |
| Free hobby project | Supabase Free | $0 | No time limit, zero config |
| Low-cost dev/test DB | Supabase Pro | $25 | Simple flat rate, includes compute, storage, and bandwidth |
| AWS trial or AWS-focused team | AWS Free Tier | $0 (12 mo) | Best value compute & storage for teams already using AWS |
| Cost-sensitive production workload | RDS Reserved | $4.76–$96 | Long-term commitment cuts RDS compute cost by up to 60% | [...] Need more than a database? Our next post will compare Supabase vs AWS pricing across auth, messaging, and more.

## FAQ#

### Is Supabase free?#

Yes, Supabase offers a free tier that lasts forever (no time limit). It includes a shared CPU with 500MB RAM, 500MB database storage, and 5GB outbound bandwidth, but no automatic backups. It is ideal for hobby projects, quick MVPs, or internal tools with light traffic.

### What is included in the Supabase free tier?#
- https://www.supabase.com/pricing Skip to content

# Predictable pricing, designed to scale

Start building for free, collaborate with your team, then scale to millions of users

## AI tools

Ask ChatGPTAsk Claude

Perfect for passion projects & simple websites.

Start for Free

/ month

Get started with:

 Unlimited API requests
 50,000 monthly active users
 500 MB database size

  Shared CPU • 500 MB RAM
 5 GB egress
 5 GB cached egress
 1 GB file storage
 Community support [...] Database

| Feature | Included |
| Dedicated Postgres Database | Included in free |
| Unlimited API requests | Included in free |
| Database size | 500 MB database size per project included |
| Advanced disk config | Not included in free |
| Automatic backups | Not included in free |
| Point in time recovery | Not included in free |
| Pausing | After 1 week of inactivity |
| Branching | Not included in free |
| Egress | 5 GB included |
| Pipelines | Not included in free |

Auth [...] Storage

| Feature | Included |
| Storage | 1 GB included |
| Cached Egress | 5 GB included |
| Custom access controls | Included in free |
| Max file upload size | 50 MB |
| Content Delivery Network | Basic CDN |
| Image Transformations | Not included in free |

Realtime

| Feature | Included |
| Postgres Changes | Included in free |
| Concurrent Peak Connections | 200 included |
| Messages Per Month | 2 Million included |
| Max Message Size | 256 KB |

Edge Functions
- https://supabase.com/pricing#! Skip to content

# Predictable pricing, designed to scale

Start building for free, collaborate with your team, then scale to millions of users

## AI tools

Ask ChatGPTAsk Claude

Perfect for passion projects & simple websites.

Start for Free

/ month

Get started with:

 Unlimited API requests
 50,000 monthly active users
 500 MB database size

  Shared CPU • 500 MB RAM
 5 GB egress
 5 GB cached egress
 1 GB file storage
 Community support [...] Database

| Feature | Included |
| Dedicated Postgres Database | Included in free |
| Unlimited API requests | Included in free |
| Database size | 500 MB database size per project included |
| Advanced disk config | Not included in free |
| Automatic backups | Not included in free |
| Point in time recovery | Not included in free |
| Pausing | After 1 week of inactivity |
| Branching | Not included in free |
| Egress | 5 GB included |
| Pipelines | Not included in free |

Auth [...] Storage

| Feature | Included |
| Storage | 1 GB included |
| Cached Egress | 5 GB included |
| Custom access controls | Included in free |
| Max file upload size | 50 MB |
| Content Delivery Network | Basic CDN |
| Image Transformations | Not included in free |

Realtime

| Feature | Included |
| Postgres Changes | Included in free |
| Concurrent Peak Connections | 200 included |
| Messages Per Month | 2 Million included |
| Max Message Size | 256 KB |

Edge Functions
- https://supabase.com/pricing Skip to content

# Predictable pricing, designed to scale

Start building for free, collaborate with your team, then scale to millions of users

Ask ChatGPTAsk Claude

Perfect for passion projects & simple websites.

Start for Free

/ month

Get started with:

 Unlimited API requests
 50,000 monthly active users
 500 MB database size

  Shared CPU • 500 MB RAM
 5 GB egress
 5 GB cached egress
 1 GB file storage
 Community support [...] Database

| Feature | Included |
| Dedicated Postgres Database | Included in free |
| Unlimited API requests | Included in free |
| Database size | 500 MB database size per project included |
| Advanced disk config | Not included in free |
| Automatic backups | Not included in free |
| Point in time recovery | Not included in free |
| Pausing | After 1 week of inactivity |
| Branching | Not included in free |
| Egress | 5 GB included |
| Pipelines | Not included in free |

Auth
- https://supabase.com/pricing?ref=scrimba.com Start building for free, collaborate with your team, then scale to millions of users

## AI tools

Ask ChatGPTAsk Claude

Perfect for passion projects & simple websites.

Start for Free

/ month

Get started with:

 Unlimited API requests
 50,000 monthly active users
 500 MB database size

  Shared CPU • 500 MB RAM
 5 GB egress
 5 GB cached egress
 1 GB file storage
 Community support

Free projects are paused after 1 week of inactivity. Limit of 2 active projects.

### Pro

Most Popular [...] Database

| Feature | Included |
| Dedicated Postgres Database | Included in free |
| Unlimited API requests | Included in free |
| Database size | 500 MB database size per project included |
| Advanced disk config | Not included in free |
| Automatic backups | Not included in free |
| Point in time recovery | Not included in free |
| Pausing | After 1 week of inactivity |
| Branching | Not included in free |
| Egress | 5 GB included |
| Pipelines | Not included in free |

Auth
- https://supabase.com/pricing?compare-plans= Start building for free, collaborate with your team, then scale to millions of users

## AI tools

Ask ChatGPTAsk Claude

Perfect for passion projects & simple websites.

Start for Free

/ month

Get started with:

 Unlimited API requests
 50,000 monthly active users
 500 MB database size

  Shared CPU • 500 MB RAM
 5 GB egress
 5 GB cached egress
 1 GB file storage
 Community support

Free projects are paused after 1 week of inactivity. Limit of 2 active projects.

### Pro

Most Popular [...] Database

| Feature | Included |
| Dedicated Postgres Database | Included in free |
| Unlimited API requests | Included in free |
| Database size | 500 MB database size per project included |
| Advanced disk config | Not included in free |
| Automatic backups | Not included in free |
| Point in time recovery | Not included in free |
| Pausing | After 1 week of inactivity |
| Branching | Not included in free |
| Egress | 5 GB included |
| Pipelines | Not included in free |

Auth
- https://www.neon.com/pricing + Free plan: up to 100 projects at $0, each with its own 100 CU-hours and 1 GB of storage, enough to build and test a database-per-tenant app.
  + Launch and Scale: you pay only for the compute each tenant actually runs and the storage it holds. Idle tenant databases scale to zero, so inactive tenants don't add compute cost; storage is still billed. Launch includes 100 projects, and Scale includes 1,000, with more on request. [...] See what's recently landed on the Neon backend: Object Storage, Functions, AI Gateway, and more

Discord23.3k

Log inSign up

# Neon pricing

Get started for free. Pay per usage as you grow.

## Neon pricing plans

 ### Free

  #### $0

  Build and learn free with no time limits and no credit card required.

  Try Neon

  Lakebase Postgres

  + 100 projects
  + 100 CU-hrs monthly per project
  + 1 GB of storage per project
  + Sizes up to 2 CU (8 GB RAM)
  + Unlimited team members

  Backend [...] $0/monthGet started

  + 100
  + 10
  + 100 CU-hoursPer Project
  + Up to 2 CU (8 GB RAM)
  + After 5 minutes when inactive
  + Free1 GB per Project
  + Freewith limited window/size
  + Up to 6 hoursor 1 GB of data changes
  + 1 snapshot
  + Up to 60k MAUs per project
  + 5 GB included
  + Compute10 active capacity-hours per project400 waiting capacity-hours per project
- https://neon.com/pricing#instant-restores + Free plan: up to 100 projects at $0, each with its own 100 CU-hours and 1 GB of storage, enough to build and test a database-per-tenant app.
  + Launch and Scale: you pay only for the compute each tenant actually runs and the storage it holds. Idle tenant databases scale to zero, so inactive tenants don't add compute cost; storage is still billed. Launch includes 100 projects, and Scale includes 1,000, with more on request. [...] See what's recently landed on the Neon backend: Object Storage, Functions, AI Gateway, and more

Discord23.3k

Log inSign up

# Neon pricing

Get started for free. Pay per usage as you grow.

## Neon pricing plans

 ### Free

  #### $0

  Build and learn free with no time limits and no credit card required.

  Try Neon

  Lakebase Postgres

  + 100 projects
  + 100 CU-hrs monthly per project
  + 1 GB of storage per project
  + Sizes up to 2 CU (8 GB RAM)
  + Unlimited team members

  Backend [...] $0/monthGet started

  + 100
  + 10
  + 100 CU-hoursPer Project
  + Up to 2 CU (8 GB RAM)
  + After 5 minutes when inactive
  + Free1 GB per Project
  + Freewith limited window/size
  + Up to 6 hoursor 1 GB of data changes
  + 1 snapshot
  + Up to 60k MAUs per project
  + 5 GB included
  + Compute10 active capacity-hours per project400 waiting capacity-hours per project
- https://neon.com/pricing#additional-branches-billing + Free plan: up to 100 projects at $0, each with its own 100 CU-hours and 1 GB of storage, enough to build and test a database-per-tenant app.
  + Launch and Scale: you pay only for the compute each tenant actually runs and the storage it holds. Idle tenant databases scale to zero, so inactive tenants don't add compute cost; storage is still billed. Launch includes 100 projects, and Scale includes 1,000, with more on request. [...] $0/monthGet started

  + 100
  + 10
  + 100 CU-hoursPer Project
  + Up to 2 CU (8 GB RAM)
  + After 5 minutes when inactive
  + Free1 GB per Project
  + Freewith limited window/size
  + Up to 6 hoursor 1 GB of data changes
  + 1 snapshot
  + Up to 60k MAUs per project
  + 5 GB included
  + Compute10 active capacity-hours per project400 waiting capacity-hours per project [...] Build your agent on Neon and provision backends you fully control. See how Ideavo does it

Discord23.3k

Log inSign up

# Neon pricing

Get started for free. Pay per usage as you grow.

## Neon pricing plans

 ### Free

  #### $0

  Build and learn free with no time limits and no credit card required.

  Try Neon

  Lakebase Postgres

  + 100 projects
  + 100 CU-hrs monthly per project
  + 1 GB of storage per project
  + Sizes up to 2 CU (8 GB RAM)
  + Unlimited team members

  Backend

trace: /var/folders/7h/jk4fl_rd3bn2qxznhs_l3whr0000gn/T/eval-live-jEt8sB/traces/2026-11-19-155902-compare-the-free-tiers-of-neon-and-supab.md


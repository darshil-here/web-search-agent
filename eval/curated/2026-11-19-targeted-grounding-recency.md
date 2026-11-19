# Eval report

Offline: 3/3 passed
Live: 2/3 passed

## Offline (deterministic)

| case | source | result | note |
|------|--------|:------:|------|
| grounding-001 | F-002 | pass |  |
| calibration-001 | F-004 | pass |  |
| recency-001 | F-006 | pass |  |

## Live (LLM-judged)

| case | result | answer kind | reasons |
|------|:------:|:-----------:|---------|
| grounding-001 | pass | model | Table values and claims are supported by retrieved sources, and each factual table cell includes a source URL.; Unsupported points are explicitly marked as “not stated in sources.” |
| calibration-001 | FAIL | model | The answer claims that neither free tier has a time limit that makes it expire, but no retrieved source establishes that longevity policy.; The pause and compute-suspension details are sourced, but those sources do not verify that the free tiers themselves never expire. |
| recency-001 | pass | model | The answer uses the official OpenAI Help Center page for the current price.; It notes that the Help Center page shows only a relative update time and that a calendar date is not stated.; The launch-era ChatGPT Plus article is listed among publication dates, but is not used as current evidence for the price. |

## Live failures (full answers)

### calibration-001

Answer kind: model

ANSWER:
````
**Neither free tier has a routine time limit that makes it expire.** But their free projects behave differently: - **Neon:** The free plan has no monthly charge. Its compute automatically suspends after **5 minutes of inactivity**; that’s a sleep state, not an expiration. [Neon plans](https://neon.tech/docs/introduction/plans) · [Scale to Zero](https://neon.tech/docs/introduction/scale-to-zero) - **Supabase:** The free plan also has no monthly charge, but projects with low database activity may be **paused after a week of inactivity**. That’s a pause, not an automatic expiration; you can restore a paused project from the dashboard. [Supabase pricing](https://supabase.com/docs/pricing) · [Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
````

SOURCES:
- https://neon.tech/docs/introduction/plans The Free plan costs $0/month and includes 100 projects, 10 branches per project, 100 CU-hours of compute per project per month, autoscaling up to 2 CU (≈8 GB RAM), 1 GB of Postgres storage per project (up to 20 GB total across all projects), and 5 GB of public network transfer per project per month. It also includes a 6-hour instant restore history (up to 1 GB of changes per project), 1 manual snapshot, up to 60,000 Managed Better Auth MAU per project, 1 day of monitoring history, and community [...] On the Free plan, there is no monthly cost. You get usage allowances for projects, branches, compute, storage, and more, for $0/month.

### Who it's for [...] Free: Up to 2 CU (8 GB RAM)
 Launch: Up to 16 CU (64 GB RAM)
 Scale: Up to 16 CU for autoscaling; fixed sizes up to 56 CU (224 GB RAM)

> Autoscaling is capped at 16 CU. Scale supports fixed computes above 16 CU.

### Scale to zero

Suspends computes after inactivity.

 Free: 5 min inactivity; cannot disable
 Launch: 5 min inactivity; can disable
 Scale: Fully configurable; 1 minute to always on

### Storage

Storage is your data size, billed on actual usage in GB-months, measured hourly.
- https://neon.tech/docs/manage/projects #### important

If you are any of Neon's paid plans, deleting all your Neon projects won't stop monthly billing. To avoid charges, you also need to downgrade to the Free plan. You can do so from the Billing page in the Neon Console.

#### note

Deleted projects can be recovered within the deletion recovery period (7 days) from the Console, CLI, or API. For details, see Recover a deleted project.

## Manage projects with the Neon API [...] Postgres storage depends on your Neon plan. On paid plans (Launch and Scale), there's no hard per-branch size limit; your storage grows with your usage, and you pay only for the storage you use. The Free plan includes 1 GB of Postgres storage per project, shared across all branches. This is separate from Object Storage, which has its own allowance. [...] On the Free plan, updates are automatically scheduled. On paid plans, you can set a preferred day and time for updates. Restarts occur within your selected time window and take only a few seconds.

To set your project's update schedule or view currently scheduled updates:

1. Go to Settings > Postgres and find Updates.
2. Choose a day of the week and an hour. Updates will occur within this time window and take only a few seconds.

For more information, see Updates.
- https://neon.tech/docs/guides/scale-to-zero-guide When a compute suspends and later restarts, the session context resets. This includes in-memory statistics, temporary tables, prepared statements, and autovacuum thresholds, among other session-specific data. If your workflow requires persistent session data, consider disabling scale to zero on a paid plan to keep your compute active continuously. On the Free plan, scale to zero is always enabled and automatically suspends your compute after 5 minutes of inactivity.

## Need help? [...] View as Markdown

Neon's Scale to Zero feature controls whether a Neon compute transitions to an idle state due to inactivity. For example, if scale to zero is enabled, your compute will transition to an idle state after it's been inactive for 5 minutes. Neon's paid plans allow you to disable scale to zero to keep your compute active. On the Scale plan, you can configure the scale to zero threshold.

#### important
- https://neon.tech/docs/introduction/roadmap Postgres 18: Now the default version for all newly created projects.
 Project recovery: Accidentally deleted a project? You can now recover it within 7 days of deletion. This feature restores your entire project infrastructure, including all branches, endpoints, compute configurations, and project settings. Learn more.
 100 Free plan projects: The Neon Free plan now includes 100 projects, giving you plenty of room to experiment, prototype, and build. Learn more. [...] Archive storage on the Free plan: Archive storage is now available on the Free plan for automatically archiving inactive branches. This feature helps minimize storage costs, allowing us to expand the Free plan even further. Learn more in Branch Archiving. [...] Automatic cache prewarming: Neon now prewarms your compute's in-memory cache during scheduled compute updates, protecting query performance immediately after the update restarts Postgres. Read the blog post
 Unlimited org members on the Free plan: You can now add unlimited members to each organization on the Free plan. The members API supports pagination and sorting, and the Console shows a 2FA indicator per member. Learn more.
- https://neon.tech/docs/introduction/scale-to-zero The diagram below illustrates the Scale to Zero behavior alongside Neon's Autoscaling feature. The compute usage line highlights an inactive period, followed by a period where the compute is automatically suspended until it's accessed again.

Neon compute scales to zero after an inactive period of 5 minutes. For Neon Free plan users, this setting is fixed. Paid plan users can disable the scale-to-zero setting to maintain an always-active compute.

#### note
- https://supabase.com/docs/guides/platform/free-project-pausing Projects under a paid plan cannot be paused and are not subject to automatic pausing for inactivity. To pause a project currently under a paid plan, first transfer the project to an organization on the Free plan.

## How automatic pausing works [...] A Free plan project is considered inactive if it does not receive sufficient user database activity over the past week. Projects with too few user queries during that window are the clearest candidates for pausing. While you may be actively using the project, it's possible that usage is not enough to exclude it from automatic pausing. Typically a few user requests to the database each day over the previous week is enough to keep the project from being paused. [...] Supabase wordmarkSupabase wordmarkDOCS

 Start

Supabase wordmarkSupabase wordmarkDOCS

Updated

Project Pausing

Supabase pauses Free Plan projects that show low activity over a 7-day period to save server resources. This guide explains how pausing works, how to restore a paused project, and how to avoid pausing altogether.
- https://supabase.com/docs/guides/platform/project-pausing Projects under a paid plan cannot be paused and are not subject to automatic pausing for inactivity. To pause a project currently under a paid plan, first transfer the project to an organization on the Free plan.

## How automatic pausing works [...] A Free plan project is considered inactive if it does not receive sufficient user database activity over the past week. Projects with too few user queries during that window are the clearest candidates for pausing. While you may be actively using the project, it's possible that usage is not enough to exclude it from automatic pausing. Typically a few user requests to the database each day over the previous week is enough to keep the project from being paused. [...] Supabase wordmarkSupabase wordmarkDOCS

 Start

Supabase wordmarkSupabase wordmarkDOCS

Updated

Project Pausing

Supabase pauses Free Plan projects that show low activity over a 7-day period to save server resources. This guide explains how pausing works, how to restore a paused project, and how to avoid pausing altogether.
- https://supabase.com/docs/pricing Database

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

Auth [...] Start building for free, collaborate with your team, then scale to millions of users

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

Most Popular [...] Yes, you can pause a project at any time. Our Free Plan gives you 2 free projects, but you can have as many paused projects as you want. Just pause and unpause them as needed.
- https://supabase.com/docs/guides/deployment/going-into-prod + The default rate limit for auth emails when using a custom SMTP provider is 30 new users per hour. If you are doing a major public announcement, you will likely require more than this.
 We may pause applications on the Free Plan that exhibit low activity in a 7-day period to save on server resources.
  + You can restore paused projects from the Supabase dashboard.
  + Upgrade to Pro to guarantee that we won't pause your project for inactivity.
- https://supabase.com/docs/guides/platform/manage-your-subscription When you downgrade from a paid plan to the Free Plan, you will get credits for the unused time on the paid plan. However, you will also be charged for any excessive usage in the billing cycle.

The plan line item (e.g. Pro Plan) gets charged upfront, whereas all usage charges get charged in arrears, as we only know your usage by the end of the billing cycle. Excessive usage is charged whenever a billing cycle resets, so either when your monthly cycle resets, or whenever you do a plan change. [...] Example: If you start a Pro Plan subscription on January 1 and downgrade to the Free Plan on January 15, your organization will receive about 50% of the subscription fee as credits for the unused time between January 15 and January 31.

As stated in our Terms of Service, we do not offer refunds to the payment method on file.

#### Charges on downgrade# [...] If you got charged after downgrading to the Free Plan, you had excessive usage in the previous billing cycle. You can check your invoices to see what exactly you were charged for.

### Cancel subscription#

To cancel your subscription, go to your organization's billing settings, click "Change subscription plan" and select the Free Plan. The cancellation is immediate, refer to downgrade docs for full details.

trace: /var/folders/7h/jk4fl_rd3bn2qxznhs_l3whr0000gn/T/eval-live-mAZd9h/traces/2026-11-19-171544-do-the-neon-and-supabase-free-tiers-expi.md


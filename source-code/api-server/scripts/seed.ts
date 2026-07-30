import { db, prospectsTable, followupsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { generateScheduledTime, getScheduleWindow } from "../services/timingEngine";

const GAMING_COMPANIES = [
  { company: "Playrix", domain: "playrix.com" },
  { company: "Moon Active", domain: "moonactive.com" },
  { company: "Nexters", domain: "nexters.com" },
  { company: "Scopely", domain: "scopely.com" },
  { company: "InnoGames", domain: "innogames.com" },
  { company: "Dream11", domain: "dream11.com" },
  { company: "Wildlife Studios", domain: "wildlifestudios.com" },
  { company: "Kolibri Games", domain: "kolibrigames.com" },
  { company: "Jam City", domain: "jamcity.com" },
  { company: "Tilting Point", domain: "tiltingpoint.com" },
  { company: "AppLovin", domain: "applovin.com" },
  { company: "Voodoo", domain: "voodoo.io" },
  { company: "Supercell", domain: "supercell.com" },
  { company: "Playtika", domain: "playtika.com" },
  { company: "SciPlay", domain: "sciplay.com" },
  { company: "Tripledot Studios", domain: "tripledotstudios.com" },
  { company: "Socialpoint", domain: "socialpoint.es" },
  { company: "Peak Games", domain: "peak.com" },
];

const NON_GAMING_COMPANIES = [
  { company: "Bumble", domain: "bumble.com" },
  { company: "Noom", domain: "noom.com" },
  { company: "SmartNews", domain: "smartnews.com" },
  { company: "Careem", domain: "careem.com" },
  { company: "FunCorp", domain: "funcorp.com" },
  { company: "Headspace", domain: "headspace.com" },
  { company: "Duolingo", domain: "duolingo.com" },
  { company: "Flo Health", domain: "flo.health" },
  { company: "Calm", domain: "calm.com" },
  { company: "Blinkist", domain: "blinkist.com" },
  { company: "Meesho", domain: "meesho.com" },
  { company: "Rappi", domain: "rappi.com" },
  { company: "Swiggy", domain: "swiggy.com" },
  { company: "iFood", domain: "ifood.com.br" },
  { company: "SHEIN", domain: "shein.com" },
];

const CPS_COMPANIES = [
  { company: "Revolut", domain: "revolut.com" },
  { company: "Tinkoff", domain: "tinkoff.ru" },
  { company: "N26", domain: "n26.com" },
  { company: "Tabby", domain: "tabby.ai" },
  { company: "Tamara", domain: "tamara.co" },
  { company: "PayPal", domain: "paypal.com" },
  { company: "Wise", domain: "wise.com" },
  { company: "Klarna", domain: "klarna.com" },
  { company: "Nubank", domain: "nubank.com.br" },
  { company: "Chime", domain: "chime.com" },
  { company: "Robinhood", domain: "robinhood.com" },
  { company: "SoFi", domain: "sofi.com" },
];

const RETARGETING_COMPANIES = [
  { company: "Wolt", domain: "wolt.com" },
  { company: "Getir", domain: "getir.com" },
  { company: "Glovo", domain: "glovoapp.com" },
  { company: "Bolt", domain: "bolt.eu" },
  { company: "Free Now", domain: "free-now.com" },
  { company: "Lyft", domain: "lyft.com" },
  { company: "Grab", domain: "grab.com" },
  { company: "Gojek", domain: "gojek.com" },
];

const FIRST_NAMES = [
  "Alex", "Sara", "Dmitry", "James", "Lena", "Ravi", "Maria", "Tom",
  "Nina", "Chris", "Yuki", "Ahmed", "Julia", "Mark", "David", "Anna",
  "Wei", "Sophie", "Omar", "Elena", "Carlos", "Priya", "Jan", "Lisa",
  "Kenji", "Fatima", "Hans", "Rachel", "Ivan", "Mia", "Pierre", "Aisha",
  "Stefan", "Olga", "Raj", "Isabelle", "Tomas", "Yara", "Felix", "Nadia",
];

const LAST_NAMES = [
  "Kim", "Chen", "Volkov", "Park", "Braun", "Patel", "Santos", "Fischer",
  "Kowalski", "Taylor", "Tanaka", "Hassan", "Morozova", "Johnson", "Lee",
  "Petrova", "Zhang", "Martin", "Al-Rashid", "Mueller", "Garcia", "Singh",
  "Novak", "Anderson", "Watanabe", "Ali", "Schmidt", "Berg", "Ivanov",
  "Costa", "Laurent", "Khan", "Becker", "Larsson", "Nakamura", "Rossi",
];

const GAMING_SUBJECTS = [
  "Scaling UA for midcore — MobUpps approach",
  "Your next 50M installs — UA strategy for {company}",
  "MobUpps x {company} — performance UA at scale",
  "Ad monetization + UA synergy for {company}",
  "Breaking into T1 markets — UA playbook for {company}",
];

const NON_GAMING_SUBJECTS = [
  "Mobile growth for {company} — MobUpps capabilities",
  "Driving quality installs for {company}",
  "MobUpps performance marketing for {company}",
  "Scaling {company} UA with transparent ROAS",
  "User acquisition partnership — MobUpps x {company}",
];

const CPS_SUBJECTS = [
  "CPS model for {company} — pay per result",
  "Performance-based fintech growth — MobUpps x {company}",
  "Driving depositing users for {company}",
  "MobUpps CPS — risk-free growth for {company}",
];

const RETARGETING_SUBJECTS = [
  "Re-engaging lapsed users — MobUpps retargeting for {company}",
  "Retargeting at scale — MobUpps x {company}",
  "Bringing users back to {company} — performance retargeting",
];

const BODY_TEMPLATES = [
  "Hi {name},\n\nI noticed {company} has been expanding its mobile presence significantly. At MobUpps, we work with similar companies to drive high-quality installs at transparent, performance-based pricing.\n\nWe currently run campaigns across 50+ traffic sources with full fraud detection and real-time ROAS optimization. Our average client sees 30-40% improvement in CPI within the first 60 days.\n\nWould a 15-minute call this week make sense to explore fit?\n\nBest,\nMichael",
  "Hi {name},\n\nQuick note — I was looking at {company}'s recent growth and think there's a strong opportunity to accelerate your UA with MobUpps. We specialize in performance marketing for mobile apps, running campaigns across premium and programmatic inventory.\n\nOur approach: transparent pricing, fraud-free traffic, and dedicated campaign management. We currently work with several companies in your space.\n\nHappy to share specifics — are you open to a brief conversation?\n\nBest,\nMichael",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDate(daysAgo: number, daysAgoEnd: number): Date {
  const now = Date.now();
  const start = now - daysAgo * 86400000;
  const end = now - daysAgoEnd * 86400000;
  return new Date(start + Math.random() * (end - start));
}

function generateThreadId(): string {
  return "thread_" + Math.random().toString(36).slice(2, 14);
}

function generateMessageId(): string {
  return "msg_" + Math.random().toString(36).slice(2, 14);
}

interface BatchDef {
  vertical: string;
  product: string;
  companies: Array<{ company: string; domain: string }>;
  subjects: string[];
  batchDate: Date;
  label: string;
}

async function seed() {
  console.log("\n-- Seeding test data --\n");

  await db.delete(followupsTable);
  await db.delete(prospectsTable);
  console.log("  Cleared existing data");

  let totalInserted = 0;

  const batches: BatchDef[] = [
    {
      vertical: "gaming_ua", product: "ua",
      companies: GAMING_COMPANIES.slice(0, 12),
      subjects: GAMING_SUBJECTS,
      batchDate: randomDate(6, 5),
      label: "doctrine/gaming-ua",
    },
    {
      vertical: "non_gaming_ua", product: "ua",
      companies: NON_GAMING_COMPANIES.slice(0, 10),
      subjects: NON_GAMING_SUBJECTS,
      batchDate: randomDate(6, 5),
      label: "doctrine/non-gaming-ua",
    },
    {
      vertical: "gaming_ua", product: "ua",
      companies: GAMING_COMPANIES.slice(6),
      subjects: GAMING_SUBJECTS,
      batchDate: randomDate(4, 3),
      label: "doctrine/gaming-ua",
    },
    {
      vertical: "cps", product: "cps",
      companies: CPS_COMPANIES,
      subjects: CPS_SUBJECTS,
      batchDate: randomDate(4, 3),
      label: "doctrine/cps",
    },
    {
      vertical: "non_gaming_ua", product: "ua",
      companies: NON_GAMING_COMPANIES.slice(5),
      subjects: NON_GAMING_SUBJECTS,
      batchDate: randomDate(4, 3),
      label: "doctrine/non-gaming-ua",
    },
    {
      vertical: "retargeting", product: "retargeting",
      companies: RETARGETING_COMPANIES,
      subjects: RETARGETING_SUBJECTS,
      batchDate: randomDate(2, 1),
      label: "doctrine/retargeting",
    },
    {
      vertical: "cps", product: "cps",
      companies: CPS_COMPANIES.slice(0, 6),
      subjects: CPS_SUBJECTS,
      batchDate: randomDate(2, 1),
      label: "doctrine/cps",
    },
  ];

  const allProspectIds: Array<{ id: number; vertical: string; daysAgo: number }> = [];

  for (const batch of batches) {
    for (const comp of batch.companies) {
      const numContacts = 1 + Math.floor(Math.random() * 3);
      for (let c = 0; c < numContacts; c++) {
        const firstName = pick(FIRST_NAMES);
        const lastName = pick(LAST_NAMES);
        const name = `${firstName} ${lastName}`;
        const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${comp.domain}`;

        const subject = pick(batch.subjects).replace("{company}", comp.company);
        const body = pick(BODY_TEMPLATES)
          .replace("{name}", firstName)
          .replace("{company}", comp.company);

        const sentAt = batch.batchDate;
        const threadId = generateThreadId();
        const messageId = generateMessageId();

        const inserted = await db
          .insert(prospectsTable)
          .values({
            gmailMessageId: messageId,
            gmailThreadId: threadId,
            prospectName: name,
            company: comp.company,
            email,
            vertical: batch.vertical,
            product: batch.product,
            subject,
            originalBodySummary: body.slice(0, 500),
            batchLabel: batch.label,
            sentAt,
          })
          .onConflictDoNothing()
          .returning({ id: prospectsTable.id });

        if (inserted.length > 0) {
          const daysAgo = Math.floor((Date.now() - sentAt.getTime()) / 86400000);
          allProspectIds.push({ id: inserted[0].id, vertical: batch.vertical, daysAgo });
        }

        totalInserted++;
      }
    }
  }

  console.log(`  Inserted ${totalInserted} prospects`);

  const toReply = allProspectIds
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.floor(allProspectIds.length * 0.15));

  for (const p of toReply) {
    await db
      .update(prospectsTable)
      .set({ replied: 1, repliedAt: new Date() })
      .where(eq(prospectsTable.id, p.id));
  }

  console.log(`  Marked ${toReply.length} as replied`);

  const unreplied = allProspectIds.filter(
    (p) => !toReply.find((r) => r.id === p.id)
  );

  const oldUnreplied = unreplied.filter((p) => p.daysAgo >= 4);
  const toQueue = oldUnreplied
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.floor(oldUnreplied.length * 0.2));

  let queuedCount = 0;
  for (const p of toQueue) {
    const window = getScheduleWindow(1);
    const scheduledAt = generateScheduledTime(window);
    await db
      .insert(followupsTable)
      .values({
        prospectId: p.id,
        stage: 1,
        scheduledAt: new Date(scheduledAt),
      })
      .onConflictDoNothing();
    queuedCount++;
  }

  console.log(`  Created ${queuedCount} queued follow-ups`);

  const toMarkSent = oldUnreplied
    .filter((p) => !toQueue.find((q) => q.id === p.id))
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.floor(oldUnreplied.length * 0.05));

  let sentCount = 0;
  for (const p of toMarkSent) {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1 - Math.floor(Math.random() * 3));

    await db
      .insert(followupsTable)
      .values({
        prospectId: p.id,
        stage: 1,
        status: "sent",
        scheduledAt: pastDate,
        sentAt: pastDate,
        generatedBody: "Test follow-up body",
        generatedSubject: "Re: Test subject",
      })
      .onConflictDoNothing();
    sentCount++;
  }

  console.log(`  Created ${sentCount} sent follow-ups`);

  const stats = await db
    .select({
      total: sql<number>`count(*)`,
      unrepliedCount: sql<number>`sum(case when ${prospectsTable.replied} = 0 then 1 else 0 end)`,
      repliedCount: sql<number>`sum(case when ${prospectsTable.replied} = 1 then 1 else 0 end)`,
    })
    .from(prospectsTable);

  const fuStats = await db
    .select({
      queued: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)`,
      sent: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)`,
    })
    .from(followupsTable);

  console.log("\n-- Summary --\n");
  console.log(`  Prospects: ${stats[0]?.total || 0} total, ${stats[0]?.unrepliedCount || 0} unreplied, ${stats[0]?.repliedCount || 0} replied`);
  console.log(`  Follow-ups: ${fuStats[0]?.queued || 0} queued, ${fuStats[0]?.sent || 0} sent`);
  console.log("\n  Start the server with: pnpm --filter @workspace/api-server run dev\n");

  process.exit(0);
}

seed().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

import { ALL_DOCTRINE_LABELS } from "../lib/constants";
import { newGoogleOAuthClient, newGmailClient } from "../lib/googleApi";

const LABELS = [...ALL_DOCTRINE_LABELS];

async function main() {
  // F-3.7b: bounded construction — see lib/googleApi.ts.
  const auth = newGoogleOAuthClient();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const gmail = newGmailClient(auth);

  const existing = await gmail.users.labels.list({ userId: "me" });
  const existingMap = new Map<string, string>();
  for (const label of existing.data.labels || []) {
    if (label.name && label.id) {
      existingMap.set(label.name, label.id);
    }
  }

  console.log("\n-- Gmail Label Setup --\n");

  for (const labelName of LABELS) {
    if (existingMap.has(labelName)) {
      console.log(`  [ok] "${labelName}" already exists (ID: ${existingMap.get(labelName)})`);
      continue;
    }

    try {
      const result = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });

      console.log(`  + Created "${labelName}" (ID: ${result.data.id})`);
      existingMap.set(labelName, result.data.id || "");
    } catch (err: any) {
      if (err.code === 409) {
        console.log(`  [ok] "${labelName}" already exists (conflict)`);
      } else {
        console.error(`  [fail] Failed to create "${labelName}":`, err.message);
      }
    }
  }

  console.log("\n-- Label IDs for .env / Doctrine config --\n");
  for (const labelName of LABELS) {
    const id = existingMap.get(labelName);
    if (id) {
      const envKey = labelName
        .replace("doctrine/", "LABEL_ID_")
        .replace("doctrine", "LABEL_ID_PARENT")
        .replace(/-/g, "_")
        .toUpperCase();
      console.log(`  ${envKey}=${id}`);
    }
  }

  console.log("\n-- Add to your Doctrine .env --\n");
  console.log(`  DOCTRINE_GMAIL_LABEL_ID=${existingMap.get("doctrine") || "NOT_FOUND"}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

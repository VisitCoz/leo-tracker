// ============================================================
//  ask-leo — Supabase Edge Function (Deno)
//  The secure "brain": holds the Anthropic API key as a secret,
//  calls Claude Opus, returns the reply. The app NEVER sees the key.
//
//  Deploy:  npx supabase functions deploy ask-leo
//  Secret:  npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//  (JWT verification is ON by default, so only a logged-in family
//   member can call this — protects the key from abuse.)
// ============================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-opus-4-8";
const BIRTH_DATE = new Date("2026-01-23T00:00:00");

// Browser calls need CORS headers (and an OPTIONS preflight reply).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---- Compute Leo's age in "X mo Y d" from his birth date -------
function ageString(now: Date): string {
  let months = (now.getFullYear() - BIRTH_DATE.getFullYear()) * 12 +
    (now.getMonth() - BIRTH_DATE.getMonth());
  let days = now.getDate() - BIRTH_DATE.getDate();
  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    days += prevMonth;
  }
  return `${months} months ${days} days`;
}

// ---- Leo's profile + the family's parenting philosophy ---------
// This is the stable system prompt. cache_control marks it cacheable.
const LEO_PROFILE = `You are a warm, knowledgeable infant sleep and development assistant for the parents of a baby named Leo. You are speaking with Leo's parents, Mike and Emma. You are NOT a doctor — for any medical concern (fever, breathing, feeding refusal, illness, growth worries) gently tell them to contact their pediatrician.

# About Leo
Leo was born on January 23, 2026. ALWAYS reason from his age based on that birth date (it is provided to you each message). He is generally a happy, healthy baby.

# Parenting philosophy — FOLLOW THIS STRICTLY
The parents use a gentle, responsive approach. You MUST:
- Be gentle and responsive; follow Leo's cues; avoid rigid schedules.
- NEVER recommend "cry-it-out" or any method that involves leaving him to cry for long periods, or forcing independence before he is ready.
- Focus on healthy sleep foundations and gradual, respectful progress over quick fixes.
- Prioritize attachment, sleep quality, and family well-being.
- Explain BOTH what is developmentally normal AND practical, concrete steps they can take.
- Distinguish what is normal/age-appropriate (reassure) from what may need adjustment.
- Base advice on infant sleep science, stated plainly. Be practical and specific.

# Current sleep background
- Part of the night in a crib next to the parents' bed; often starts the night transferred asleep into the crib; sometimes finishes the night in the parents' bed after waking. They are gradually, slowly transitioning toward a full-size crib and eventual independent sleep, at his readiness — no rushing.

# Bedtime routine
Diaper change, pajamas, dim lights, white noise, bottle/feed before bed, rocking/soothing to sleep. They value consistency but allow flexibility.

# Sleep & nap patterns
- Wake-up around 7:00 AM. Bedtime varies ~7:00–8:30 PM depending on naps/tiredness; sometimes longer sleep with a slightly later bedtime, but early ~7pm nights also work.
- Do NOT assume one fixed bedtime — recommend a bedtime based on nap quality, wake windows, mood/cues, and total daytime sleep.
- Morning nap is often longest/most successful; afternoon naps shorter/less predictable. Recent naps: 30–45 min common, occasional 1h, occasional 1.5h stroller naps. Short naps are developmentally normal — troubleshoot without assuming something is wrong.

# Wake windows (guided by cues, not forced)
~75 min when tired or after short naps; ~90 min average; up to ~105 min when well-rested. Never push a wake window if he is clearly tired.

# Sleep development
Leo is around the 4-month stage: sleep cycles maturing, nap lengths inconsistent, patterns changing frequently. Emphasize that these changes are developmentally normal; reassure when behavior is age-appropriate.

# Feeding
Breastfed plus some formula. Hunger may still contribute to night waking — encourage responsive feeding based on cues; avoid strict feeding schedules.

# Style
Be warm, concise, and specific. Lead with reassurance when behavior is normal. Give 1–3 concrete, gentle next steps. Use the logged data you're given to personalize. Never use cry-it-out. Keep medical issues with the pediatrician.`;

async function callClaude(system: any[], messages: any[], maxTokens: number, effort: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  // Concatenate the text blocks (thinking blocks are omitted by default).
  return (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { mode, messages = [], activity = "" } = await req.json();
    const age = ageString(new Date());

    // Stable profile (cacheable) + a small volatile block with age + today's data.
    const system = [
      { type: "text", text: LEO_PROFILE, cache_control: { type: "ephemeral" } },
      { type: "text", text: `Today's context — Leo's current age: ${age}.\nRecent activity:\n${activity || "(no activity logged yet today)"}` },
    ];

    let reply: string;
    if (mode === "insight") {
      // One short, proactive recommendation card.
      reply = await callClaude(
        system,
        [{
          role: "user",
          content:
            "Based on Leo's age and today's logged activity, give ONE short proactive insight for right now (2–4 sentences). Cover the likely next nap or tonight's bedtime window and one gentle, practical tip. Reassure if things look developmentally normal. No greeting, no preamble — just the insight.",
        }],
        500,
        "low",
      );
    } else {
      // Chat: pass the conversation history straight through.
      reply = await callClaude(system, messages, 2000, "high");
    }

    return new Response(JSON.stringify({ reply }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

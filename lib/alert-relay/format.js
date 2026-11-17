// The Telegram wording of an alarm from this stack, keyed by the SUFFIX of the
// alarm name (the prefix is the stack name). Same shape as the relay of
// dilaya/aws-sqlite-data: an unknown alarm is still announced, with its own
// CloudWatch reason as the body.
const EXPLANATIONS = [
  ["-status-check", "La VM Forgejo a raté un contrôle d'état EC2 (machine ou système)."],
  ["-disk", "Un disque de la VM Forgejo dépasse 80 % : agrandir le volume de données (gp3, en ligne)."],
  ["-backup-stale", "Aucune sauvegarde Forgejo réussie vers S3 depuis 26 h."],
  ["-https", "Forgejo ne répond plus en HTTPS (VM, Caddy, certificat ou Forgejo arrêté) : les dépôts sont injoignables."],
];

function explain(name) {
  const hit = EXPLANATIONS.find(([suffix]) => typeof name === "string" && name.endsWith(suffix));
  return hit ? hit[1] : "";
}

function formatMessage(alarm) {
  const name = (alarm && alarm.AlarmName) || "alarme inconnue";
  const state = alarm && alarm.NewStateValue;
  const reason = (alarm && alarm.NewStateReason) || "";
  if (state === "ALARM") {
    const body = [explain(name), reason].filter(Boolean).join("\n\n");
    return `🔴 Dilaya Git (Forgejo) — « ${name} » est en ALARME.\n${body}`;
  }
  if (state === "OK") return `🟢 Dilaya Git (Forgejo) — « ${name} » est rétablie.`;
  return `⚪️ Dilaya Git (Forgejo) — « ${name} » : ${state}.\n${reason}`;
}

module.exports = { formatMessage, explain };

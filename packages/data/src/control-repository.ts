import type { DatabaseSync } from 'node:sqlite';

function integrityAlert(db: DatabaseSync, deviceId: string, at: string, code: string, detail: Record<string, unknown>) {
  db.prepare(`INSERT OR IGNORE INTO alerts(device_id,code,severity,opened_at,details_json)
    VALUES(? ,?,'critical',?,?)`).run(deviceId, code, at, JSON.stringify(detail));
}

function reconcileCompletion(db: DatabaseSync, commandId: string): boolean {
  const command = db.prepare('SELECT status FROM commands WHERE id=?').get(commandId) as { status: string } | undefined;
  if (!command || !['accepted', 'unknown'].includes(command.status)) return false;
  const matched = db.prepare(`SELECT 1 FROM command_acks a JOIN irrigation_events e
    ON e.device_id=a.device_id AND e.boot_id=a.boot_id AND e.command_id=a.command_id AND e.pulse_id=a.pulse_id
    WHERE a.command_id=? AND a.status='completed' AND e.event_type='PULSE_ENDED' AND e.actual_ms IS NOT NULL LIMIT 1`)
    .get(commandId);
  if (!matched) return false;
  db.prepare("UPDATE commands SET status='completed',reason_code=NULL WHERE id=?").run(commandId);
  return true;
}

export type NewCommand = {
  id: string; deviceId: string; targetBootId: string; createdAt: string; expiresAt: string;
  durationMs: number; source: 'device' | 'simulator'; topic: string; packet: Record<string, unknown>;
};

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function queueCommand(db: DatabaseSync, command: NewCommand): void {
  if (!Number.isInteger(command.durationMs) || command.durationMs < 1 || command.durationMs > 3000 ||
      Date.parse(command.expiresAt) - Date.parse(command.createdAt) !== 10000 ||
      command.packet.commandId !== command.id || command.packet.deviceId !== command.deviceId ||
      command.packet.targetBootId !== command.targetBootId ||
      (command.packet.payload as Record<string, unknown>)?.durationMs !== command.durationMs)
    throw new Error('Invalid command');
  transaction(db, () => {
    db.prepare(`INSERT INTO commands(id,device_id,target_boot_id,created_at,expires_at,duration_ms,status,source)
      VALUES(?,?,?,?,?,?,'queued',?)`).run(command.id, command.deviceId, command.targetBootId,
      command.createdAt, command.expiresAt, command.durationMs, command.source);
    db.prepare('INSERT INTO command_outbox(command_id,topic,payload_json) VALUES(?,?,?)')
      .run(command.id, command.topic, JSON.stringify(command.packet));
  });
}

export function pendingCommands(db: DatabaseSync, now: string): { id: string; topic: string; packet: string }[] {
  return db.prepare(`SELECT c.id, o.topic, o.payload_json AS packet FROM command_outbox o
    JOIN commands c ON c.id=o.command_id WHERE o.published_at IS NULL AND c.status='queued'
    AND c.expires_at>? ORDER BY c.created_at`).all(now) as { id: string; topic: string; packet: string }[];
}

export function markPublished(db: DatabaseSync, id: string, at: string): boolean {
  return transaction(db, () => {
    const row = db.prepare('SELECT status FROM commands WHERE id=?').get(id) as { status: string } | undefined;
    if (!row || row.status !== 'queued') return false;
    db.prepare('UPDATE commands SET status=? WHERE id=?').run('published', id);
    db.prepare('UPDATE command_outbox SET published_at=? WHERE command_id=?').run(at, id);
    return true;
  });
}

export function recordAck(db: DatabaseSync, ack: {
  deviceId: string; bootId: string; seq: number; commandId: string; status: 'accepted' | 'rejected' | 'completed' | 'failed';
  reasonCode: string | null; pulseId: string | null; receivedAt: string; payloadHash: string;
}): 'advanced' | 'duplicate' | 'conflict' | 'unmatched' | 'held' {
  return transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)')
      .run(ack.deviceId, ack.bootId, ack.receivedAt);
    const prior = db.prepare(`SELECT kind,payload_hash FROM packet_ledger WHERE device_id=? AND boot_id=? AND seq=?`)
      .get(ack.deviceId, ack.bootId, ack.seq) as { kind: string; payload_hash: string } | undefined;
    if (prior) {
      if (prior.kind === 'acks' && prior.payload_hash === ack.payloadHash) return 'duplicate';
      integrityAlert(db, ack.deviceId, ack.receivedAt, 'SEQ_CONFLICT', { seq: ack.seq });
      return 'conflict';
    }
    const command = db.prepare('SELECT status,device_id,target_boot_id FROM commands WHERE id=?')
      .get(ack.commandId) as { status: string; device_id: string; target_boot_id: string } | undefined;
    if (!command || command.device_id !== ack.deviceId || command.target_boot_id !== ack.bootId) return 'unmatched';
    db.prepare("INSERT INTO packet_ledger(device_id,boot_id,seq,kind,payload_hash) VALUES(?,?,?,'acks',?)")
      .run(ack.deviceId, ack.bootId, ack.seq, ack.payloadHash);
    db.prepare(`INSERT INTO command_acks(device_id,boot_id,seq,topic,command_id,status,reason_code,pulse_id,received_at,payload_hash)
      VALUES(?,?,?,'acks',?,?,?,?,?,?)`).run(ack.deviceId, ack.bootId, ack.seq, ack.commandId,
        ack.status, ack.reasonCode, ack.pulseId, ack.receivedAt, ack.payloadHash);
    const terminal = ['completed', 'rejected', 'failed'];
    if (terminal.includes(command.status)) {
      if (terminal.includes(ack.status) && ack.status !== command.status)
        integrityAlert(db, ack.deviceId, ack.receivedAt, 'TERMINAL_ACK_CONFLICT', { commandId: ack.commandId });
      return 'held';
    }
    const allowed: Record<string, string[]> = {
      queued: ['accepted', 'rejected', 'failed'], published: ['accepted', 'rejected', 'failed'],
      accepted: ['failed'], unknown: ['failed', 'rejected'],
    };
    if (!(allowed[command.status] ?? []).includes(ack.status)) return reconcileCompletion(db, ack.commandId) ? 'advanced' : 'held';
    db.prepare('UPDATE commands SET status=?,reason_code=? WHERE id=?').run(ack.status, ack.reasonCode, ack.commandId);
    reconcileCompletion(db, ack.commandId);
    return 'advanced';
  });
}

export function recordEvent(db: DatabaseSync, event: {
  deviceId: string; bootId: string; seq: number; eventId: string; eventType: 'PULSE_STARTED' | 'PULSE_ENDED' | 'STATE_CHANGED' | 'FAULT_RAISED' | 'FAULT_CLEARED';
  pulseId: string | null; commandId: string | null; triggerSource: 'AUTO' | 'BUTTON' | 'WEB';
  actualMs: number | null; reasonCode: string | null; receivedAt: string; payloadHash: string;
}): 'inserted' | 'duplicate' | 'conflict' {
  return transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)')
      .run(event.deviceId, event.bootId, event.receivedAt);
    const prior = db.prepare('SELECT kind,payload_hash FROM packet_ledger WHERE device_id=? AND boot_id=? AND seq=?')
      .get(event.deviceId, event.bootId, event.seq) as { kind: string; payload_hash: string } | undefined;
    if (prior) {
      if (prior.kind === 'events' && prior.payload_hash === event.payloadHash) return 'duplicate';
      integrityAlert(db, event.deviceId, event.receivedAt, 'SEQ_CONFLICT', { seq: event.seq });
      return 'conflict';
    }
    db.prepare("INSERT INTO packet_ledger(device_id,boot_id,seq,kind,payload_hash) VALUES(?,?,?,'events',?)")
      .run(event.deviceId, event.bootId, event.seq, event.payloadHash);
    db.prepare(`INSERT INTO irrigation_events(device_id,boot_id,seq,event_id,event_type,pulse_id,command_id,
      trigger_source,actual_ms,reason_code,received_at,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.deviceId, event.bootId, event.seq, event.eventId, event.eventType, event.pulseId,
        event.commandId, event.triggerSource, event.actualMs, event.reasonCode, event.receivedAt, event.payloadHash);
    if (event.commandId && event.eventType === 'PULSE_ENDED') reconcileCompletion(db, event.commandId);
    return 'inserted';
  });
}

export function saveDesiredSettings(db: DatabaseSync, deviceId: string, revision: number,
  values: Record<string, unknown>, issuedAt: string, receivedAt: string): void {
  transaction(db, () => {
    const latest = db.prepare('SELECT MAX(revision) AS revision FROM settings_desired WHERE device_id=?').get(deviceId) as { revision: number | null };
    if (latest.revision !== null && revision <= latest.revision) throw new Error('Old desired revision');
    db.prepare(`INSERT INTO settings_desired(device_id,revision,values_json,issued_at,received_at,status)
      VALUES(?,?,?,?,?,'pending')`).run(deviceId, revision, JSON.stringify(values), issuedAt, receivedAt);
  });
}

export function queueDesiredSettings(db: DatabaseSync, deviceId: string, values: Record<string, unknown>,
  issuedAt: string, topic: string, packet: Record<string, unknown>): number {
  return transaction(db, () => {
    const latest = db.prepare('SELECT MAX(revision) AS revision FROM settings_desired WHERE device_id=?')
      .get(deviceId) as { revision: number | null };
    const revision = (latest.revision ?? 0) + 1;
    if (packet.deviceId !== deviceId || packet.revision !== revision || packet.issuedAt !== issuedAt ||
        JSON.stringify(packet.values) !== JSON.stringify(values)) throw new Error('Invalid desired settings packet');
    db.prepare(`INSERT INTO settings_desired(device_id,revision,values_json,issued_at,received_at,status)
      VALUES(?,?,?,?,?,'pending')`).run(deviceId, revision, JSON.stringify(values), issuedAt, issuedAt);
    db.prepare('INSERT INTO settings_outbox(device_id,revision,topic,payload_json) VALUES(?,?,?,?)')
      .run(deviceId, revision, topic, JSON.stringify(packet));
    return revision;
  });
}

export function pendingDesiredSettings(db: DatabaseSync): { device_id: string; revision: number; topic: string; packet: string }[] {
  return db.prepare(`SELECT o.device_id,o.revision,o.topic,o.payload_json AS packet
    FROM settings_outbox o JOIN settings_desired d USING(device_id,revision)
    WHERE o.published_at IS NULL AND d.status='pending' ORDER BY d.issued_at,o.revision`)
    .all() as { device_id: string; revision: number; topic: string; packet: string }[];
}

export function markDesiredSettingsPublished(db: DatabaseSync, deviceId: string, revision: number, at: string): boolean {
  return transaction(db, () => {
    const result = db.prepare(`UPDATE settings_outbox SET published_at=? WHERE device_id=? AND revision=?
      AND published_at IS NULL AND EXISTS(SELECT 1 FROM settings_desired WHERE device_id=? AND revision=? AND status='pending')`)
      .run(at, deviceId, revision, deviceId, revision);
    return Number(result.changes) === 1;
  });
}

export function requestDesiredSettingsReplay(db: DatabaseSync, deviceId: string): boolean {
  const result = db.prepare(`UPDATE settings_outbox SET published_at=NULL WHERE device_id=? AND revision=(
    SELECT MAX(revision) FROM settings_desired WHERE device_id=? AND status='pending'
  ) AND EXISTS(SELECT 1 FROM settings_desired WHERE device_id=? AND revision=settings_outbox.revision AND status='pending')`)
    .run(deviceId, deviceId, deviceId);
  return Number(result.changes) === 1;
}

export function saveReportedSettings(db: DatabaseSync, deviceId: string, revision: number,
  values: Record<string, unknown>, calibrationRevision: number, rejectedRevision: number | null,
  reasonCode: string | null, receivedAt: string): 'applied' | 'rejected' | 'mismatch' {
  return transaction(db, () => {
    db.prepare(`INSERT INTO settings_reported(device_id,revision,values_json,calibration_revision,rejected_revision,reason_code,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(deviceId, revision, JSON.stringify(values), calibrationRevision,
        rejectedRevision, reasonCode, receivedAt);
    if (rejectedRevision !== null) {
      db.prepare(`UPDATE settings_desired SET status='rejected' WHERE device_id=? AND revision=?`).run(deviceId, rejectedRevision);
      return 'rejected';
    }
    const desired = db.prepare('SELECT values_json FROM settings_desired WHERE device_id=? AND revision=?')
      .get(deviceId, revision) as { values_json: string } | undefined;
    if (!desired || desired.values_json !== JSON.stringify(values)) return 'mismatch';
    db.prepare(`UPDATE settings_desired SET status='applied' WHERE device_id=? AND revision=?`).run(deviceId, revision);
    return 'applied';
  });
}

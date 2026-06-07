import mongoose from 'mongoose';
import crypto from 'crypto';

const personSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  external_id: { type: String, default: null },
  display_name: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  is_active: { type: Boolean, default: true },
  last_seen_at: { type: Date, default: null },
  total_sightings: { type: Number, default: 0 },
  confidence_score: { type: Number, default: 0.0 },
  face_model_3d: { type: Buffer, default: null },
  face_model_format: { type: String, default: 'glb' },
  face_model_updated_at: { type: Date, default: null },
  information_found: { type: mongoose.Schema.Types.Mixed, default: null },
  search_keys: [{ type: { type: String }, value: { type: String } }]
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

personSchema.index({ external_id: 1 }, { unique: true, sparse: true });
personSchema.index({ is_active: 1, created_at: -1 });
personSchema.index({ last_seen_at: -1 });
personSchema.index({ display_name: 'text' });
personSchema.index({ 'search_keys.type': 1, 'search_keys.value': 1 });

/**
 * Extract searchable key-value pairs from information_found data.
 * Used for cross-person search (finding people sharing the same phone, username, etc).
 */
personSchema.statics.extractSearchKeys = function (informationFound) {
  if (!informationFound || typeof informationFound !== 'object') return [];

  const keys = [];
  const seen = new Set();

  const add = (type, value) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    const key = `${type}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ type, value: v });
  };

  const DIRECT_FIELDS = ['phone', 'telegramId', 'telegram_id', 'email', 'inn', 'snils', 'passport'];
  const ARRAY_FIELDS = ['usernames', 'emails', 'names'];

  for (const [, data] of Object.entries(informationFound)) {
    if (!data || typeof data !== 'object') continue;

    // Direct fields on the source data
    for (const field of DIRECT_FIELDS) {
      if (data[field]) {
        const type = field === 'telegramId' || field === 'telegram_id' ? 'telegram_id' : field;
        add(type, data[field]);
      }
    }

    // Array fields
    for (const field of ARRAY_FIELDS) {
      if (Array.isArray(data[field])) {
        const type = field === 'usernames' ? 'username' : field === 'names' ? 'name' : field;
        for (const v of data[field]) add(type, v);
      }
    }

    // Name fields (fullName, name)
    if (data.fullName) add('name', data.fullName);
    if (data.name && typeof data.name === 'string') add('name', data.name);

    // Nested persons array (from photo search results)
    if (Array.isArray(data.persons)) {
      for (const p of data.persons) {
        if (!p || typeof p !== 'object') continue;
        for (const field of DIRECT_FIELDS) {
          if (p[field]) {
            const type = field === 'telegramId' || field === 'telegram_id' ? 'telegram_id' : field;
            add(type, p[field]);
          }
        }
        if (p.fullName) add('name', p.fullName);
        if (p.vk && p.vk.url) add('vk_url', p.vk.url);
      }
    }

    // Nested report.summary fields (from Sherlock full reports)
    if (data.report && data.report.summary) {
      const summary = data.report.summary;
      const SUMMARY_MAP = {
        phone: 'phone',
        email: 'email',
        inn: 'inn',
        snils: 'snils',
        passport: 'passport',
      };
      for (const [sumKey, searchType] of Object.entries(SUMMARY_MAP)) {
        if (Array.isArray(summary[sumKey])) {
          for (const entry of summary[sumKey]) {
            add(searchType, entry.value || entry);
          }
        }
      }
    }
  }

  return keys;
};

personSchema.statics.getStatistics = async function (id) {
  const person = await this.findById(id, 'display_name external_id total_sightings last_seen_at face_model_3d').lean();
  if (!person) return null;

  const Trait = mongoose.model('Trait');
  const Sighting = mongoose.model('Sighting');

  const [traitCounts, sightingStats] = await Promise.all([
    Trait.aggregate([
      { $match: { person_id: id } },
      { $group: { _id: '$trait_type', count: { $sum: 1 } } }
    ]),
    Sighting.aggregate([
      { $match: { person_id: id } },
      {
        $group: {
          _id: null,
          cameras_seen_on: { $addToSet: '$camera_id' },
          avg_confidence: { $avg: '$confidence_score' },
          first_seen: { $min: '$detected_at' },
          last_seen: { $max: '$detected_at' }
        }
      }
    ])
  ]);

  const traitMap = {};
  for (const t of traitCounts) {
    traitMap[t._id] = t.count;
  }

  const stats = sightingStats[0] || { cameras_seen_on: [], avg_confidence: null, first_seen: null, last_seen: null };

  return {
    id: person._id,
    display_name: person.display_name,
    external_id: person.external_id,
    total_sightings: person.total_sightings,
    last_seen_at: person.last_seen_at,
    face_traits_count: traitMap.face || 0,
    gait_traits_count: traitMap.gait || 0,
    cameras_seen_on: stats.cameras_seen_on.length,
    avg_confidence: stats.avg_confidence,
    first_seen: stats.first_seen,
    last_seen: stats.last_seen,
    has_face3d_model: person.face_model_3d != null
  };
};

const Person = mongoose.model('Person', personSchema);

export default Person;

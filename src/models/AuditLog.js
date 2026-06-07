import mongoose from 'mongoose';
import crypto from 'crypto';

const auditLogSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  table_name: { type: String, required: true },
  record_id: { type: String, required: true },
  action: { type: String, required: true, enum: ['INSERT', 'UPDATE', 'DELETE'] },
  old_values: { type: mongoose.Schema.Types.Mixed, default: null },
  new_values: { type: mongoose.Schema.Types.Mixed, default: null },
  changed_by: { type: String, default: null },
  changed_at: { type: Date, default: Date.now },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: false,
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

auditLogSchema.index({ table_name: 1 });
auditLogSchema.index({ record_id: 1 });
auditLogSchema.index({ changed_at: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;

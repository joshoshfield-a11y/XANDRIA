
import { Entity, Component, ComponentType, LogEvent } from './types';

export class ECSEngine {
  private entities: Entity[] = [];
  private nextId = 0;
  private logCallback: (event: LogEvent) => void = () => {};

  setLogCallback(cb: (event: LogEvent) => void) {
    this.logCallback = cb;
  }

  private emitLog(message: string, type: LogEvent['type'] = 'ECS_LIFECYCLE', severity: LogEvent['severity'] = 'INFO', metadata?: any) {
    this.logCallback({
      id: Math.random().toString(36).substr(2, 9),
      type,
      message,
      severity,
      timestamp: Date.now(),
      metadata
    });
  }

  createEntity(label: string = 'Unnamed Entity'): number {
    const id = this.nextId++;
    this.entities.push({ id, components: new Map() });
    this.emitLog(`Created entity [${id}] : ${label}`);
    return id;
  }

  addComponent(entityId: number, type: ComponentType, data: Record<string, any>) {
    const entity = this.entities.find(e => e.id === entityId);
    if (entity) {
      entity.components.set(type, { type, data });
      this.emitLog(`Attached ${type} to entity [${entityId}]`, 'ECS_LIFECYCLE', 'INFO', data);
    }
  }

  updateComponent(entityId: number, type: ComponentType, data: Record<string, any>) {
    const entity = this.entities.find(e => e.id === entityId);
    if (entity) {
      const comp = entity.components.get(type);
      if (comp) {
        comp.data = { ...comp.data, ...data };
      }
    }
  }

  getEntityAt(x: number, y: number, radius: number = 20): number | null {
    for (const entity of this.entities) {
      const transform = entity.components.get('Transform');
      if (transform) {
        const dx = transform.data.x - x;
        const dy = transform.data.y - y;
        if (Math.sqrt(dx * dx + dy * dy) <= radius) {
          return entity.id;
        }
      }
    }
    return null;
  }

  removeComponent(entityId: number, type: ComponentType) {
    const entity = this.entities.find(e => e.id === entityId);
    if (entity && entity.components.has(type)) {
      entity.components.delete(type);
      this.emitLog(`Detached ${type} from entity [${entityId}]`, 'ECS_LIFECYCLE', 'WARN');
    }
  }

  getEntities() {
    return this.entities;
  }

  getEntity(id: number) {
    return this.entities.find(e => e.id === id);
  }

  // Systems
  update(dt: number) {
    this.physicsSystem(dt);
    this.statsSystem(dt);
  }

  private physicsSystem(dt: number) {
    for (const entity of this.entities) {
      const transform = entity.components.get('Transform');
      const physics = entity.components.get('Physics');

      if (transform && physics) {
        // Apply acceleration to velocity
        physics.data.vx += (physics.data.ax || 0) * dt;
        physics.data.vy += (physics.data.ay || 0) * dt;
        
        // Apply velocity to position
        transform.data.x += physics.data.vx * dt;
        transform.data.y += physics.data.vy * dt;

        // Boundary checks
        if (transform.data.y > 550) {
          transform.data.y = 550;
          physics.data.vy *= -0.6; // Bounce damping
        }
        if (transform.data.x < 50 || transform.data.x > 750) {
          physics.data.vx *= -1;
        }
      }
    }
  }

  private statsSystem(dt: number) {
    for (const entity of this.entities) {
      const stats = entity.components.get('Stats');
      if (stats && stats.data.mana < stats.data.maxMana) {
        stats.data.mana = Math.min(stats.data.maxMana, stats.data.mana + (stats.data.manaRegen || 1) * dt);
      }
    }
  }

  clear() {
    this.entities = [];
    this.nextId = 0;
    this.emitLog("Kernel purged. All entities decommissioned.", 'ECS_LIFECYCLE', 'WARN');
  }
}

export const engine = new ECSEngine();

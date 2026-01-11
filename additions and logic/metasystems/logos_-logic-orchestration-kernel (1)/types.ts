
export type ComponentType = 
  | 'Transform' 
  | 'Physics' 
  | 'Render' 
  | 'Stats' 
  | 'InputMap' 
  | 'AiLogic';

export interface Component {
  type: ComponentType;
  data: Record<string, any>;
}

export interface Entity {
  id: number;
  components: Map<ComponentType, Component>;
}

export interface ASTNode {
  type: string;
  value?: any;
  children?: ASTNode[];
}

export interface VerificationProperty {
  id: string;
  name: string;
  description: string;
  invariant: string;
}

export interface VerificationResult {
  property: string;
  status: 'PASS' | 'FAIL' | 'PENDING' | 'CRITICAL_VIOLATION';
  proof: string;
  timestamp: number;
  astRef?: string;
}

export interface LogEvent {
  id: string;
  type: 'ECS_LIFECYCLE' | 'SYSTEM_UPDATE' | 'VERIFICATION' | 'BRIDGE_SIGNAL';
  message: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  timestamp: number;
  metadata?: any;
}

export interface MiddlewareMapping {
  input: string;
  action: string;
  vector: [number, number];
}

/**
 * Project Manager
 * Handles CRUD operations for game projects
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { GameProject } from './types';

export class ProjectManager {
  private projects: Map<string, GameProject> = new Map();
  private projectDirectory: string;

  constructor(projectDirectory: string = './projects') {
    this.projectDirectory = projectDirectory;
  }

  /**
   * Initialize the project manager and load existing projects
   */
  async initialize(): Promise<void> {
    console.log('📂 Initializing Project Manager...');

    try {
      await fs.mkdir(this.projectDirectory, { recursive: true });
      await this.loadExistingProjects();
      console.log(`✅ Loaded ${this.projects.size} existing projects`);
    } catch (error) {
      console.warn('⚠️ Could not initialize project directory:', error);
    }
  }

  /**
   * Load existing projects from disk
   */
  private async loadExistingProjects(): Promise<void> {
    try {
      const entries = await fs.readdir(this.projectDirectory, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectId = entry.name;
          const projectPath = path.join(this.projectDirectory, projectId);
          const project = await this.loadProjectFromDirectory(projectPath, projectId);

          if (project) {
            this.projects.set(projectId, project);
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ Could not load existing projects:', error);
    }
  }

  /**
   * Load a single project from directory
   */
  private async loadProjectFromDirectory(dirPath: string, projectId: string): Promise<GameProject | null> {
    try {
      // Load metadata
      const metadataPath = path.join(dirPath, 'metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);

      // Load code
      const codePath = path.join(dirPath, 'code.js');
      let code = '';
      try {
        code = await fs.readFile(codePath, 'utf8');
      } catch {
        // Try alternative locations
        const altCodePath = path.join(dirPath, 'game.js');
        code = await fs.readFile(altCodePath, 'utf8');
      }

      return {
        ...metadata,
        code,
        id: projectId
      };
    } catch (error) {
      console.warn(`⚠️ Could not load project ${projectId}:`, error);
      return null;
    }
  }

  /**
   * Create a new project
   */
  createProject(name: string, description: string): GameProject {
    const project: GameProject = {
      id: `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      description,
      code: '',
      qualityMetrics: null,
      evolutionHistory: [],
      aiEnhancements: [],
      synestheticBindings: [],
      lastModified: Date.now(),
      status: 'generating'
    };

    this.projects.set(project.id, project);
    return project;
  }

  /**
   * Get a project by ID
   */
  getProject(projectId: string): GameProject | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Get all projects
   */
  getAllProjects(): GameProject[] {
    return Array.from(this.projects.values());
  }

  /**
   * Update a project
   */
  updateProject(projectId: string, updates: Partial<GameProject>): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;

    Object.assign(project, updates);
    project.lastModified = Date.now();
    return true;
  }

  /**
   * Delete a project
   */
  deleteProject(projectId: string): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;

    this.projects.delete(projectId);

    // Delete from disk asynchronously
    this.deleteProjectFromDisk(projectId).catch(error => {
      console.warn(`⚠️ Could not delete project ${projectId} from disk:`, error);
    });

    return true;
  }

  /**
   * Save a project to disk
   */
  async saveProject(project: GameProject): Promise<void> {
    const projectPath = path.join(this.projectDirectory, project.id);

    try {
      // Create project directory
      await fs.mkdir(projectPath, { recursive: true });

      // Save metadata
      const metadata = {
        ...project,
        code: undefined // Don't save code in metadata
      };
      await fs.writeFile(
        path.join(projectPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );

      // Save code
      await fs.writeFile(
        path.join(projectPath, 'code.js'),
        project.code
      );

      console.log(`💾 Project saved: ${project.name}`);
    } catch (error) {
      console.error(`❌ Failed to save project ${project.name}:`, error);
      throw error;
    }
  }

  /**
   * Export a project to a specified location
   */
  async exportProject(projectId: string, exportPath: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    try {
      await fs.mkdir(exportPath, { recursive: true });

      // Export code
      await fs.writeFile(
        path.join(exportPath, 'game.js'),
        project.code
      );

      // Export metadata
      await fs.writeFile(
        path.join(exportPath, 'config.json'),
        JSON.stringify(project, null, 2)
      );

      console.log(`📤 Project exported to: ${exportPath}`);
    } catch (error) {
      console.error(`❌ Failed to export project ${project.name}:`, error);
      throw error;
    }
  }

  /**
   * Get project statistics
   */
  getStatistics(): {
    totalProjects: number;
    completedProjects: number;
    averageQuality: number;
    totalEvolutionImprovements: number;
  } {
    const projects = Array.from(this.projects.values());
    const completedProjects = projects.filter(p => p.status === 'complete');
    const projectsWithQuality = completedProjects.filter(p => p.qualityMetrics);

    const averageQuality = projectsWithQuality.length > 0
      ? projectsWithQuality.reduce((sum, p) => sum + (p.qualityMetrics?.overallScore || 0), 0) / projectsWithQuality.length
      : 0;

    const totalEvolutionImprovements = projects.reduce((sum, p) =>
      sum + p.evolutionHistory.reduce((eSum, e) => eSum + e.improvementMetrics.qualityImprovement, 0), 0
    );

    return {
      totalProjects: projects.length,
      completedProjects: completedProjects.length,
      averageQuality,
      totalEvolutionImprovements
    };
  }

  /**
   * Clean up old or corrupted projects
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up projects...');

    const projectsToRemove: string[] = [];

    for (const [projectId, project] of this.projects) {
      // Remove projects that are in error state and older than 24 hours
      if (project.status === 'error' &&
          Date.now() - project.lastModified > 24 * 60 * 60 * 1000) {
        projectsToRemove.push(projectId);
      }
    }

    for (const projectId of projectsToRemove) {
      await this.deleteProjectFromDisk(projectId);
      this.projects.delete(projectId);
    }

    if (projectsToRemove.length > 0) {
      console.log(`🗑️ Cleaned up ${projectsToRemove.length} old projects`);
    }
  }

  /**
   * Delete project from disk
   */
  private async deleteProjectFromDisk(projectId: string): Promise<void> {
    const projectPath = path.join(this.projectDirectory, projectId);

    try {
      await fs.rm(projectPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`⚠️ Could not delete project directory ${projectPath}:`, error);
    }
  }

  /**
   * Search projects by name or description
   */
  searchProjects(query: string): GameProject[] {
    const lowercaseQuery = query.toLowerCase();
    return Array.from(this.projects.values()).filter(project =>
      project.name.toLowerCase().includes(lowercaseQuery) ||
      project.description.toLowerCase().includes(lowercaseQuery)
    );
  }

  /**
   * Get projects by status
   */
  getProjectsByStatus(status: GameProject['status']): GameProject[] {
    return Array.from(this.projects.values()).filter(project => project.status === status);
  }
}
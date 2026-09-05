
import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { SCGNode, SCGLink } from '../types';

interface SCGViewerProps {
  nodes: SCGNode[];
  links: SCGLink[];
}

const SCGViewer: React.FC<SCGViewerProps> = ({ nodes, links }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const simulation = d3.forceSimulation(nodes as any)
      .force("link", d3.forceLink(links).id((d: any) => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2));

    const link = svg.append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", "#334155")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", 2);

    const node = svg.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .call(d3.drag<any, any>()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    node.append("circle")
      .attr("r", 10)
      .attr("fill", (d: any) => {
        switch(d.type) {
          case 'Entity': return '#06b6d4';
          case 'Constraint': return '#ef4444';
          case 'Property': return '#a855f7';
          default: return '#94a3b8';
        }
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 2);

    node.append("text")
      .text((d: any) => d.label)
      .attr("x", 12)
      .attr("y", 4)
      .attr("fill", "#e2e8f0")
      .attr("font-size", "10px")
      .attr("font-family", "Space Grotesk");

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      node.attr("transform", (d: any) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [nodes, links]);

  return (
    <div className="w-full h-full overflow-hidden bg-slate-950/50 rounded-xl border border-white/5">
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
};

export default SCGViewer;

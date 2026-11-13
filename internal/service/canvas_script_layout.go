package service

import "math"

// Place a complete production only when the user requested arrangement.
func canvasScriptProductionLayout(script *CanvasNode, nodes map[string]*CanvasNode, eligible map[string]bool, originX, originY float64) (map[string][2]float64, float64, float64) {
	positions := map[string][2]float64{}
	project := script.ScriptProject
	materialWidth, materialHeight, imageWidth, videoWidth := 240.0, 240.0, 360.0, 360.0
	materials := []*CanvasNode{}
	materialIDs := map[string]bool{}
	for _, asset := range project.Assets {
		if node := nodes[asset.ImageNodeID]; node != nil && !materialIDs[node.ID] {
			materials = append(materials, node)
			materialIDs[node.ID] = true
			materialWidth = math.Max(materialWidth, node.Width)
			materialHeight = math.Max(materialHeight, node.Height)
		}
	}
	for _, shot := range project.Shots {
		if node := nodes[shot.ImageNodeID]; node != nil {
			imageWidth = math.Max(imageWidth, node.Width)
		}
		if node := nodes[shot.VideoNodeID]; node != nil {
			videoWidth = math.Max(videoWidth, node.Width)
		}
	}
	scriptX := originX
	if len(materials) > 0 {
		scriptX += (materialWidth+36)*float64(min(2, len(materials))) + 84
	}
	imageX := scriptX + script.Width + 120
	videoX := imageX + imageWidth + 80
	place := func(id string, x, y float64) {
		if nodes[id] != nil && eligible[id] {
			if _, exists := positions[id]; !exists {
				positions[id] = [2]float64{x, y}
			}
		}
	}
	place(script.ID, scriptX, originY)
	for i, node := range materials {
		place(node.ID, originX+float64(i%2)*(materialWidth+36), originY+float64(i/2)*(materialHeight+36))
	}
	y := originY
	for _, shot := range project.Shots {
		place(shot.ImageNodeID, imageX, y)
		place(shot.VideoNodeID, videoX, y)
		height := 240.0
		for _, id := range []string{shot.ImageNodeID, shot.VideoNodeID} {
			if node := nodes[id]; node != nil {
				height = math.Max(height, node.Height)
			}
		}
		y += height + 64
	}
	place(project.MergedVideoNodeID, videoX+videoWidth+120, originY)
	right, bottom := originX, originY
	for id, point := range positions {
		right = math.Max(right, point[0]+nodes[id].Width)
		bottom = math.Max(bottom, point[1]+nodes[id].Height)
	}
	return positions, right, bottom
}

// Creation reserves paired shot rows and never moves existing nodes.
func (w *canvasAgentWorker) placeScriptShotNode(script *CanvasNode, project *CanvasScriptProject, index int, node *CanvasNode) {
	if node.Type != "image" && node.Type != "video" {
		return
	}
	node.X, node.Y = script.X+script.Width+120, script.Y
	for _, shot := range project.Shots[:index] {
		height := 480.0
		for _, id := range []string{shot.ImageNodeID, shot.VideoNodeID} {
			if other := w.node(id); other != nil {
				height = math.Max(height, other.Height)
			}
		}
		node.Y += height + 64
	}
	if node.Type == "video" {
		node.X += 480
		for _, shot := range project.Shots {
			if image := w.node(shot.ImageNodeID); image != nil {
				node.X = math.Max(node.X, image.X+image.Width+80)
			}
		}
		if image := w.node(project.Shots[index].ImageNodeID); image != nil {
			node.Y = image.Y
		}
	}
	for {
		collision := false
		for _, other := range w.doc.Nodes {
			if other.ID == node.ID || other.Type == "group" {
				continue
			}
			if node.X < other.X+other.Width+24 && node.X+node.Width+24 > other.X && node.Y < other.Y+other.Height+24 && node.Y+node.Height+24 > other.Y {
				node.Y = other.Y + other.Height + 64
				collision = true
			}
		}
		if !collision {
			return
		}
	}
}

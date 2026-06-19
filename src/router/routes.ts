import Frame1693 from "@/views/Frame1693";
import Frame164 from "@/views/Frame164";
import Frame16285 from "@/views/Frame16285";
import Frame161195 from "@/views/Frame161195";
import Frame161000 from "@/views/Frame161000";
import Frame16780 from "@/views/Frame16780";
import Frame16550 from "@/views/Frame16550";
import Frame21 from "@/views/Frame21";
import FrameStoryboard from "@/views/FrameStoryboard";
import FrameCanvas from "@/views/FrameCanvas";

export const routes = [
  {
    path: "/frame1693",
    component: Frame1693,
    guid: "16:93",
  },
  {
    path: "/frame164",
    component: Frame164,
    guid: "16:4",
  },
  {
    path: "/frame16285",
    component: Frame16285,
    guid: "16:285",
  },
  {
    path: "/frame161195",
    component: Frame161195,
    guid: "16:1195",
  },
  {
    path: "/frame161000",
    component: Frame161000,
    guid: "16:1000",
  },
  {
    path: "/frame16780",
    component: Frame16780,
    guid: "16:780",
  },
  {
    path: "/frame16550",
    component: Frame16550,
    guid: "16:550",
  },
  {
    path: "/frame-storyboard",
    component: FrameStoryboard,
    guid: "16:storyboard",
  },
  {
    path: "/frame-canvas",
    component: FrameCanvas,
    guid: "16:canvas",
  },
  {
    path: "/",
    component: Frame21,
    guid: "2:1",
  }
];

export const guidPathMap = new Map(
  routes.map((item) => [item.guid, item.path])
);
export const pathGuidMap = new Map(
  routes.map((item) => [item.path, item.guid])
);

export const getPathByGuid = (guid: string) => {
  return guidPathMap.get(guid) || "";
};

export const getGuidByPath = (path: string) => {
  return pathGuidMap.get(path) || "";
};
